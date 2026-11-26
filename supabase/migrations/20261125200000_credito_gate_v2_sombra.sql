-- Crédito-IA PR 5 — gate v2 em MODO SOMBRA + sensores (ledger).
-- Plano: docs/superpowers/plans/2026-11-25-credito-ia-pr5-sombra.md · spec §9.2/§9.5/§9.10.
-- Prova: db/test-credito-sombra.sh (PG17, C e pt_BR.UTF-8, com falsificação).
--
-- O que a sombra É: um job SQL em lote (pg_cron) que, para cada PV real de sales_orders (importado do
-- Omie OU criado no app — decisão do Lucas 2026-11-25), calcula a faixa que o gate v2 daria e grava
-- num ledger PRÓPRIO. O que ela NÃO é: nada no caminho do pedido a chama; ela não escreve em nenhuma
-- tabela do gate efetivo (credito_decisao_pedido/reserva/solicitacao), não toma o lock de grupo do
-- núcleo nem o da aprovação, e não altera private.credito_avaliar_reservar nem o piso do PR 1
-- (Codex desenho P0 — a mudança do núcleo fica para o PR 6, que promove ESTA lógica a efetivo; a
-- pós-condição confere corpo e ACL dos dois). Falha da sombra = linha de tentativa no ledger.
--
-- Diferenças da lógica sombra em relação ao núcleo do PR 2 (o que o PR 6 herda):
--   * frescor/cobertura do sync de CR por empresa do escopo (§9.5): incremental íntegro ≤ 26 h E full
--     ≤ 8 d, cada um por si (full retomado pode fechar truncado — Codex P1); ausente/futuro → 🟡;
--   * título do PRÓPRIO PV fora da soma da exposição (o PV já entra como valor) — só com vínculo
--     comprovável; continua contando no piso e na indeterminação;
--   * reserva sombra para TODO PV real avaliado (ele existe no Omie: é exposição de verdade, qualquer
--     que fosse a faixa). O que ela ocupa é DERIVADO na hora: compromisso original − Σ títulos
--     vinculados (2 lotes nunca descontam o mesmo título 2×; vínculo ambíguo ou título sem valor mantém
--     a cobertura cheia — Codex P1). Libera SÓ com cancelamento vindo do Omie (deleted_at não prova);
--   * prazo desconhecido (importado, Colacor sem catálogo, 999) → 🟡 prazo_ilegivel, nunca 🟢; a
--     faixa "se o prazo fosse aceito" fica ao lado (faixa_sem_prazo) para calibrar sem fabricar;
--   * PV em trânsito do grupo que a sombra não mede (valor ilegível ou ainda sem reserva) → 🟡
--     exposicao_indeterminada (a carga inicial só deixa de pesar depois de drenada — Codex P1).
-- Sem BEGIN/COMMIT: a transação é do `bun run db:aplicar`.

-- ── 0. pré-condições ───────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
      'public.credito_grupo_raiz(text,bigint)', 'public.credito_grupo_pares(uuid)',
      'public.credito_grupo_assinatura(uuid)', 'public.venda_gate_credito_grupo(uuid,text,bigint)',
      'public.credito_portao(text)', 'public.credito_guarda_escrita()',
      'public.pode_ver_carteira_completa(uuid)',
      'private.credito_avaliar_reservar(uuid,text,bigint,text,numeric,integer,text,uuid)'] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'PRE credito-sombra: % não existe', f;
    END IF;
  END LOOP;
  IF to_regclass('public.credito_limite') IS NULL OR to_regclass('public.credito_operacao_revisao') IS NULL
     OR to_regclass('public.sync_state') IS NULL OR to_regclass('cron.job') IS NULL THEN
    RAISE EXCEPTION 'PRE credito-sombra: tabela de dependência ausente';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'fin_contas_receber'
         AND column_name IN ('numero_pedido','valor_documento','omie_codigo_lancamento','updated_at')) <> 4 THEN
    RAISE EXCEPTION 'PRE credito-sombra: fin_contas_receber sem as colunas do vínculo PV→título';
  END IF;
END
$pre$;

-- corpo + ACL do gate efetivo ANTES: a pós-condição exige que continuem idênticos
CREATE TEMP TABLE _efetivo_antes ON COMMIT DROP AS
  SELECT oid, md5(prosrc) AS corpo, proacl::text AS acl FROM pg_proc
   WHERE oid IN ('private.credito_avaliar_reservar(uuid,text,bigint,text,numeric,integer,text,uuid)'::regprocedure,
                 'public.venda_gate_credito_grupo(uuid,text,bigint)'::regprocedure);

-- índices do vínculo PV→título (lidos a cada lote)
CREATE INDEX IF NOT EXISTS sales_orders_account_numero_pedido_idx
  ON public.sales_orders (account, omie_numero_pedido);
CREATE INDEX IF NOT EXISTS fin_contas_receber_company_numero_pedido_idx
  ON public.fin_contas_receber (company, numero_pedido) WHERE numero_pedido IS NOT NULL;

-- ── 1. Tabelas (ledger da sombra) ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.credito_sombra_marco (
  marco text PRIMARY KEY DEFAULT 'ativacao' CHECK (marco = 'ativacao'),
  ativado_em timestamptz NOT NULL DEFAULT now()
);

-- Inventário CONGELADO na ativação (Codex P1). aberto = estava em trânsito (importado/separacao/
-- enviado) → carga inicial (avaliada e reservada, fora da distribuição). PV fora desta lista nasceu
-- depois da ativação (a distribuição).
CREATE TABLE IF NOT EXISTS public.credito_sombra_carga (
  sales_order_id uuid PRIMARY KEY,
  aberto boolean NOT NULL,
  marco text NOT NULL DEFAULT 'ativacao' CHECK (marco = 'ativacao')
);

CREATE TABLE IF NOT EXISTS public.credito_sombra_lote (
  id uuid PRIMARY KEY,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  terminado_em timestamptz,
  avaliados integer,
  erros integer,
  pulados integer,
  liberadas integer,
  transferidas integer,
  pendentes integer,                 -- candidatos deixados para o próximo lote (teto/orçamento de tempo)
  status text NOT NULL DEFAULT 'rodando' CHECK (status IN ('rodando','ok')),
  CHECK ((status = 'rodando') = (terminado_em IS NULL))
);

-- Decisão simulada: 1 por (PV, empresa, versão). Append-only.
CREATE TABLE IF NOT EXISTS public.credito_sombra_decisao (
  id uuid PRIMARY KEY,
  lote_id uuid NOT NULL REFERENCES public.credito_sombra_lote(id),
  sales_order_id uuid NOT NULL,
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  origem text NOT NULL CHECK (origem IN ('app','omie')),
  versao text NOT NULL,              -- app: id da revisão (PR 3); omie: 'omie:<n>' por mudança de conteúdo
  conteudo_md5 text NOT NULL,
  omie_codigo_cliente bigint,
  grupo_user_id uuid,
  grupo_assinatura text,
  valor_brl numeric NOT NULL CHECK (valor_brl > 0 AND valor_brl < 1e12),
  prazo_dias integer,                -- NULL = desconhecido (importado / ilegível / Colacor sem catálogo)
  faixa text NOT NULL CHECK (faixa IN ('verde','amarelo','vermelho')),
  motivo text NOT NULL CHECK (motivo IN (
    'piso_vencido_60d','piso_indeterminado','sem_grupo','grupo_conflito','sync_defasado',
    'sem_limite','grupo_mudou','limite_desatualizado','risco_alto','risco_sem_evidencia',
    'prazo_ilegivel','prazo_acima','exposicao_indeterminada','estoura_limite','dentro_limite')),
  -- a mesma cadeia SEM os testes de prazo: calibra quanto do 🟡 é só prazo; nunca vira decisão
  faixa_sem_prazo text NOT NULL CHECK (faixa_sem_prazo IN ('verde','amarelo','vermelho')),
  motivo_sem_prazo text NOT NULL,
  exposicao_titulos_brl numeric,
  exposicao_reservas_brl numeric,
  limite_brl numeric,
  prazo_max_dias integer,
  limite_versao integer,
  piso jsonb NOT NULL,
  sync jsonb NOT NULL,
  carga_inicial boolean NOT NULL,
  status_pedido text NOT NULL,       -- status na 1ª observação desta versão (faturado = coorte retrospectiva)
  pedido_data_comercial date,        -- importado: created_at = data comercial às 12h UTC, não a hora real
  avaliado_em timestamptz NOT NULL DEFAULT now(),   -- ≈ 1ª observação (lote a cada 10 min)
  UNIQUE (sales_order_id, company, versao),
  CHECK (prazo_dias IS NOT NULL OR faixa <> 'verde')   -- prazo ausente nunca é 🟢
);
CREATE INDEX IF NOT EXISTS credito_sombra_decisao_pv_idx
  ON public.credito_sombra_decisao (sales_order_id, company, avaliado_em DESC);
CREATE INDEX IF NOT EXISTS credito_sombra_decisao_dia_idx
  ON public.credito_sombra_decisao (avaliado_em);

-- Tentativa que NÃO virou decisão (erro, valor ausente/parcial). Append-only.
CREATE TABLE IF NOT EXISTS public.credito_sombra_tentativa (
  id uuid PRIMARY KEY,
  lote_id uuid NOT NULL REFERENCES public.credito_sombra_lote(id),
  sales_order_id uuid NOT NULL,
  company text NOT NULL,
  conteudo_md5 text NOT NULL,
  resultado text NOT NULL CHECK (resultado IN ('erro','valor_ausente','valor_parcial')),
  detalhe text,
  criada_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credito_sombra_tentativa_pv_idx
  ON public.credito_sombra_tentativa (sales_order_id, company, conteudo_md5);

-- Reserva sombra = compromisso ORIGINAL da versão do PV. O que ela ocupa é derivado na leitura.
CREATE TABLE IF NOT EXISTS public.credito_sombra_reserva (
  id uuid PRIMARY KEY,
  decisao_id uuid NOT NULL REFERENCES public.credito_sombra_decisao(id),
  sales_order_id uuid NOT NULL,
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  omie_codigo_cliente bigint NOT NULL,
  grupo_user_id uuid,
  valor_brl numeric NOT NULL CHECK (valor_brl > 0 AND valor_brl < 1e12),
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','substituida','transferida','liberada')),
  encerrada_em timestamptz,
  motivo_encerramento text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'ativa') = (encerrada_em IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS credito_sombra_reserva_uma_ativa
  ON public.credito_sombra_reserva (sales_order_id, company) WHERE status = 'ativa';
CREATE INDEX IF NOT EXISTS credito_sombra_reserva_par_idx
  ON public.credito_sombra_reserva (company, omie_codigo_cliente) WHERE status = 'ativa';

-- ── 2. RLS, grants e guardas (padrão do PR 2: allowlist por aclexplode + portão GUC) ─────────
DO $rls$
DECLARE
  t text;
  r record;
BEGIN
  FOREACH t IN ARRAY ARRAY['credito_sombra_marco','credito_sombra_carga','credito_sombra_lote',
                           'credito_sombra_decisao','credito_sombra_tentativa','credito_sombra_reserva'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', t);
    FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
               FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.oid = ('public.' || t)::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.%I FROM %s', t, r.papel);
      IF r.papel NOT IN ('authenticated', 'service_role', 'claude_ro') THEN
        EXECUTE format('REVOKE SELECT ON public.%I FROM %s', t, r.papel);
      END IF;
    END LOOP;
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_gestor', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
                   'USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))))',
                   t || '_select_gestor', t);
    EXECUTE format('DROP TRIGGER IF EXISTS credito_guarda_truncate ON public.%I', t);
    EXECUTE format('CREATE TRIGGER credito_guarda_truncate BEFORE TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION public.credito_guarda_escrita(''id'')', t);
  END LOOP;

  FOR r IN SELECT * FROM (VALUES
      ('credito_sombra_marco',     'marco', NULL, NULL),
      ('credito_sombra_carga',     'marco', NULL, NULL),
      ('credito_sombra_lote',      'id',    'terminado_em,avaliados,erros,pulados,liberadas,transferidas,pendentes,status', 'rodando'),
      ('credito_sombra_decisao',   'id',    NULL, NULL),
      ('credito_sombra_tentativa', 'id',    NULL, NULL),
      ('credito_sombra_reserva',   'id',    'status,encerrada_em,motivo_encerramento', 'ativa')
    ) v(tabela, chave, mutaveis, aberto) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS credito_guarda_linha ON public.%I', r.tabela);
    EXECUTE format('CREATE TRIGGER credito_guarda_linha BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.credito_guarda_escrita(%s)',
                   r.tabela,
                   concat_ws(', ', quote_literal(r.chave), quote_literal(r.mutaveis), quote_literal(r.aberto)));
  END LOOP;
END
$rls$;

-- Marco + inventário congelado (idempotente: re-aplicar não move o marco nem re-congela)
DO $carga$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.credito_sombra_marco) THEN
    PERFORM public.credito_portao('ativacao');
    INSERT INTO public.credito_sombra_marco (marco) VALUES ('ativacao');
    INSERT INTO public.credito_sombra_carga (sales_order_id, aberto)
    SELECT s.id, s.status IN ('importado','separacao','enviado') AND s.deleted_at IS NULL
      FROM public.sales_orders s;
    PERFORM public.credito_portao(NULL);
  END IF;
END
$carga$;

-- ── 3. Helpers ─────────────────────────────────────────────────────────────────────────────
-- Frescor/cobertura do CR por empresa (§9.5): TODA empresa com incremental íntegro ≤ 26 h E full ≤ 8 d,
-- cada marca única e não-futura (tolerância 5 min de relógio). Lista vazia/ausente → não ok.
CREATE OR REPLACE FUNCTION private.credito_sombra_sync(p_companies text[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c text;
  v_inc timestamptz;
  v_full timestamptz;
  v_n_inc integer;
  v_n_full integer;
  v_ok_c boolean;
  v_ok boolean := COALESCE(cardinality(p_companies), 0) > 0;
  v_emp jsonb := '{}'::jsonb;
BEGIN
  FOREACH c IN ARRAY COALESCE(p_companies, ARRAY[]::text[]) LOOP
    SELECT count(*), max(s.last_sync_at) INTO v_n_inc, v_inc
      FROM public.sync_state s WHERE s.entity_type = 'fin_cr_incremental_ok' AND s.account = c;
    SELECT count(*), max(s.last_sync_at) INTO v_n_full, v_full
      FROM public.sync_state s WHERE s.entity_type = 'fin_cr_full_ok' AND s.account = c;
    v_ok_c := v_n_inc = 1 AND v_n_full = 1
              AND v_inc <= now() + interval '5 minutes' AND v_inc > now() - interval '26 hours'
              AND v_full <= now() + interval '5 minutes' AND v_full > now() - interval '8 days';
    v_ok := v_ok AND COALESCE(v_ok_c, false);
    v_emp := v_emp || jsonb_build_object(c, jsonb_build_object('incremental_ok', v_inc, 'full_ok', v_full,
                                                                'ok', COALESCE(v_ok_c, false)));
  END LOOP;
  RETURN jsonb_build_object('ok', v_ok, 'empresas', v_emp);
END;
$$;

-- Valor do PV é medível? total finito > 0 E todo item com quantidade e preço numéricos finitos > 0.
CREATE OR REPLACE FUNCTION private.credito_sombra_valor(p_total numeric, p_items jsonb)
RETURNS text            -- 'ok' | 'valor_ausente' | 'valor_parcial'
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_total IS NULL OR NOT (p_total > 0 AND p_total < 1e12) THEN 'valor_ausente'
    WHEN p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN 'valor_parcial'
    WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_items) it
       WHERE jsonb_typeof(it) <> 'object'
          OR jsonb_typeof(it -> 'quantidade') IS DISTINCT FROM 'number'
          OR jsonb_typeof(it -> 'valor_unitario') IS DISTINCT FROM 'number'
          OR NOT ((it ->> 'quantidade')::numeric > 0 AND (it ->> 'quantidade')::numeric < 1e12)
          OR NOT ((it ->> 'valor_unitario')::numeric > 0 AND (it ->> 'valor_unitario')::numeric < 1e12))
      THEN 'valor_parcial'
    ELSE 'ok' END;
$$;

-- Σ dos títulos VINCULADOS ao PV (empresa + cliente + numero_pedido; únicos por lançamento ERP; não
-- cancelados). NULL = vínculo não comprovável (sem número, número repetido na empresa, título vinculado
-- sem valor) → quem chama mantém a cobertura cheia. 0 = vínculo comprovável e nenhum título ainda.
CREATE OR REPLACE FUNCTION private.credito_sombra_titulos_pv(p_company text, p_codigo bigint, p_numero_pv text)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_soma numeric;
  v_sem_valor integer;
BEGIN
  IF p_company IS NULL OR p_codigo IS NULL OR p_numero_pv IS NULL OR btrim(p_numero_pv) = '' THEN
    RETURN NULL;
  END IF;
  IF (SELECT count(*) FROM public.sales_orders s
       WHERE s.account = p_company AND s.omie_numero_pedido = p_numero_pv) <> 1 THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(t.valor_documento), 0), count(*) FILTER (WHERE t.valor_documento IS NULL)
    INTO v_soma, v_sem_valor
    FROM (SELECT DISTINCT ON (f.omie_codigo_lancamento) f.valor_documento
            FROM public.fin_contas_receber f
           WHERE f.company = p_company AND f.omie_codigo_cliente = p_codigo
             AND f.numero_pedido = p_numero_pv
             AND f.status_titulo IS DISTINCT FROM 'CANCELADO'
           ORDER BY f.omie_codigo_lancamento, f.updated_at DESC NULLS LAST) t;
  IF v_sem_valor > 0 THEN
    RETURN NULL;
  END IF;
  RETURN v_soma;
END;
$$;

-- O que a reserva ocupa: compromisso original − títulos vinculados (piso 0); sem vínculo, tudo.
CREATE OR REPLACE FUNCTION private.credito_sombra_residual(p_valor numeric, p_company text, p_codigo bigint,
                                                           p_sales_order_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN t.v IS NULL THEN p_valor ELSE greatest(p_valor - t.v, 0) END
    FROM (SELECT private.credito_sombra_titulos_pv(
                   p_company, p_codigo,
                   (SELECT s.omie_numero_pedido FROM public.sales_orders s WHERE s.id = p_sales_order_id)) AS v) t;
$$;

-- ── 4. Avaliador da sombra (só LÊ) ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.credito_sombra_avaliar(
  p_sales_order_id uuid,
  p_company text,
  p_codigo bigint,
  p_valor numeric,
  p_prazo_dias integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_corte date := ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 60);
  v_raiz jsonb;
  v_root uuid;
  v_assin text;
  v_piso jsonb;
  v_numero_pv text;
  v_proprio numeric;          -- Σ títulos do próprio PV (NULL = vínculo não comprovável → nada sai da soma)
  v_titulos numeric;
  v_titulos_pv numeric;
  v_indet integer;
  v_piso_indet integer;
  v_venc60 integer;
  v_venc60_fora_piso integer;
  v_sync jsonb;
  v_reservas numeric := 0;
  v_pv_indet boolean := false;
  v_lim public.credito_limite%ROWTYPE;
  v_tem_lim boolean := false;
  v_pre_faixa text;           -- decisão tomada ANTES dos testes de prazo (NULL = seguir)
  v_pre_motivo text;
  v_faixa text; v_motivo text;           -- passa 1: a decisão (com prazo)
  v_faixa_sp text; v_motivo_sp text;     -- passa 2: sem os testes de prazo (calibração)
BEGIN
  IF p_sales_order_id IS NULL OR p_company IS NULL OR p_company NOT IN ('oben','colacor','colacor_sc') THEN
    RAISE EXCEPTION 'credito_sombra_avaliar: pedido/empresa inválidos' USING ERRCODE = '22023';
  END IF;
  IF p_valor IS NULL OR NOT (p_valor > 0 AND p_valor < 1e12) THEN
    RAISE EXCEPTION 'credito_sombra_avaliar: valor ausente, não positivo ou não finito' USING ERRCODE = '22023';
  END IF;

  v_raiz := public.credito_grupo_raiz(p_company, p_codigo);
  v_root := (v_raiz ->> 'raiz')::uuid;
  IF v_root IS NOT NULL THEN
    v_assin := public.credito_grupo_assinatura(v_root);
  END IF;

  v_piso := public.venda_gate_credito_grupo(p_sales_order_id, p_company, p_codigo);

  SELECT s.omie_numero_pedido INTO v_numero_pv
    FROM public.sales_orders s WHERE s.id = p_sales_order_id AND s.account = p_company;
  v_proprio := private.credito_sombra_titulos_pv(p_company, p_codigo, v_numero_pv);

  -- mesma leitura de títulos do núcleo vigente (20261124170000) + a parte do próprio PV
  WITH escopo AS (
    SELECT p_company AS company, p_codigo AS codigo
    UNION
    SELECT g.company, g.omie_codigo_cliente FROM public.credito_grupo_pares(v_root) g WHERE v_root IS NOT NULL
  )
  SELECT COALESCE(sum(f.saldo) FILTER (WHERE f.saldo > 0), 0),
         COALESCE(sum(f.saldo) FILTER (WHERE f.saldo > 0 AND v_proprio IS NOT NULL
                                          AND f.company = p_company AND f.omie_codigo_cliente = p_codigo
                                          AND f.numero_pedido = v_numero_pv), 0),
         count(*) FILTER (WHERE f.saldo IS NULL),
         count(*) FILTER (WHERE (f.saldo IS NULL OR f.data_vencimento IS NULL)
                            AND (f.data_vencimento IS NULL OR f.data_vencimento <= v_corte)),
         count(*) FILTER (WHERE (f.saldo > 0 OR f.status_titulo = 'PAGTO PARCIAL') AND f.data_vencimento <= v_corte),
         count(*) FILTER (WHERE (f.saldo > 0 OR f.status_titulo = 'PAGTO PARCIAL') AND f.data_vencimento <= v_corte
                            AND f.status_titulo NOT IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL'))
    INTO v_titulos, v_titulos_pv, v_indet, v_piso_indet, v_venc60, v_venc60_fora_piso
    FROM escopo e
    JOIN public.fin_contas_receber f ON f.company = e.company AND f.omie_codigo_cliente = e.codigo
   WHERE e.codigo IS NOT NULL
     AND f.status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL','PAGTO PARCIAL');
  v_titulos := v_titulos - v_titulos_pv;

  v_sync := private.credito_sombra_sync(ARRAY(
    SELECT p_company
    UNION
    SELECT g.company FROM public.credito_grupo_pares(v_root) g WHERE v_root IS NOT NULL
    ORDER BY 1));

  -- ordem: dívida comprovada → piso indeterminado → identidade → sync → limite → prazo → exposição
  IF ((v_piso ->> 'bloqueado')::boolean AND COALESCE((v_piso ->> 'titulos_comprovados')::integer, 1) > 0)
     OR v_venc60_fora_piso > 0
     OR (v_venc60 > 0 AND v_piso ->> 'motivo' <> 'excecao_valida') THEN
    v_pre_faixa := 'vermelho'; v_pre_motivo := 'piso_vencido_60d';
  ELSIF v_piso_indet > 0 OR (v_piso ->> 'bloqueado')::boolean THEN
    v_pre_faixa := 'amarelo'; v_pre_motivo := 'piso_indeterminado';
  ELSIF v_root IS NULL THEN
    v_pre_faixa := 'amarelo'; v_pre_motivo := v_raiz ->> 'motivo';
  ELSIF NOT COALESCE((v_sync ->> 'ok')::boolean, false) THEN
    v_pre_faixa := 'amarelo'; v_pre_motivo := 'sync_defasado';
  ELSE
    SELECT * INTO v_lim FROM public.credito_limite l WHERE l.grupo_user_id = v_root;
    v_tem_lim := FOUND;
    IF NOT v_tem_lim THEN
      v_pre_faixa := 'amarelo'; v_pre_motivo := 'sem_limite';
    ELSIF v_lim.grupo_assinatura IS DISTINCT FROM v_assin THEN
      v_pre_faixa := 'amarelo'; v_pre_motivo := 'grupo_mudou';
    ELSIF v_lim.ficha_calculada_em < now() - interval '14 days' THEN
      v_pre_faixa := 'amarelo'; v_pre_motivo := 'limite_desatualizado';
    ELSIF v_lim.risco IN ('alto','sem_evidencia') THEN
      v_pre_faixa := 'amarelo'; v_pre_motivo := 'risco_' || v_lim.risco;
    END IF;
  END IF;

  IF v_root IS NOT NULL THEN
    -- reservas sombra ATIVAS de OUTROS PVs do grupo (par atual OU raiz gravada), pelo que ocupam hoje
    WITH escopo AS (
      SELECT p_company AS company, p_codigo AS codigo
      UNION
      SELECT g.company, g.omie_codigo_cliente FROM public.credito_grupo_pares(v_root) g
    )
    SELECT COALESCE(sum(private.credito_sombra_residual(r.valor_brl, r.company, r.omie_codigo_cliente, r.sales_order_id)), 0)
      INTO v_reservas
      FROM public.credito_sombra_reserva r
     WHERE r.status = 'ativa'
       AND (r.grupo_user_id = v_root
            OR EXISTS (SELECT 1 FROM escopo e WHERE e.company = r.company AND e.codigo = r.omie_codigo_cliente))
       AND NOT (r.sales_order_id = p_sales_order_id AND r.company = p_company);
    -- exposição que ninguém mede: PV em trânsito do grupo com valor ilegível ou ainda sem reserva sombra
    SELECT EXISTS (
      SELECT 1 FROM public.sales_orders s
        JOIN public.credito_grupo_pares(v_root) g ON g.user_id = s.customer_user_id AND g.company = s.account
       WHERE s.id <> p_sales_order_id AND s.deleted_at IS NULL
         AND s.status IN ('importado','separacao','enviado')
         AND (private.credito_sombra_valor(s.total, s.items) <> 'ok'
              OR NOT EXISTS (SELECT 1 FROM public.credito_sombra_reserva r
                              WHERE r.sales_order_id = s.id AND r.company = s.account AND r.status = 'ativa')))
      INTO v_pv_indet;
  END IF;

  FOR i IN 1..2 LOOP
    IF v_pre_faixa IS NOT NULL THEN
      v_faixa_sp := v_pre_faixa; v_motivo_sp := v_pre_motivo;
    ELSIF i = 1 AND p_prazo_dias IS NULL THEN
      v_faixa_sp := 'amarelo'; v_motivo_sp := 'prazo_ilegivel';
    ELSIF i = 1 AND p_prazo_dias > v_lim.prazo_max_dias THEN
      v_faixa_sp := 'amarelo'; v_motivo_sp := 'prazo_acima';
    ELSIF v_indet > 0 OR v_pv_indet THEN
      v_faixa_sp := 'amarelo'; v_motivo_sp := 'exposicao_indeterminada';
    ELSIF v_titulos + v_reservas + p_valor > v_lim.limite_brl THEN
      v_faixa_sp := 'amarelo'; v_motivo_sp := 'estoura_limite';
    ELSE
      v_faixa_sp := 'verde'; v_motivo_sp := 'dentro_limite';
    END IF;
    IF i = 1 THEN
      v_faixa := v_faixa_sp; v_motivo := v_motivo_sp;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'faixa', v_faixa, 'motivo', v_motivo,
    'faixa_sem_prazo', v_faixa_sp, 'motivo_sem_prazo', v_motivo_sp,
    'grupo_user_id', v_root, 'grupo_assinatura', v_assin,
    'exposicao_titulos_brl', v_titulos, 'exposicao_reservas_brl', v_reservas,
    'limite_brl', CASE WHEN v_tem_lim THEN v_lim.limite_brl END,
    'prazo_max_dias', CASE WHEN v_tem_lim THEN v_lim.prazo_max_dias END,
    'limite_versao', CASE WHEN v_tem_lim THEN v_lim.versao END,
    'piso', v_piso, 'sync', v_sync);
END;
$$;

-- ── 5. Lote (pg_cron) ──────────────────────────────────────────────────────────────────────
-- 1 lote por vez (try-lock de transação com chave EXCLUSIVA da sombra). Nenhum lock de grupo: o caminho
-- do pedido nunca espera a sombra. Cada PV num sub-bloco: erro vira tentativa, nunca aborta o lote.
-- Orçamento de tempo checado antes de cada PV; o resto fica para o próximo lote (retomável pelo ledger).
CREATE OR REPLACE FUNCTION private.credito_sombra_lote(p_max integer DEFAULT 100, p_orcamento_seg integer DEFAULT 45)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inicio timestamptz := clock_timestamp();
  v_lote uuid := gen_random_uuid();
  v_av integer := 0; v_er integer := 0; v_pu integer := 0; v_lib integer := 0; v_tr integer := 0;
  v_pend integer := 0;
  v_n integer := 0;
  c record;
  r record;
  v_dec jsonb;
  v_dec_id uuid;
  v_id uuid;
  v_valor_ok text;
  v_versao text;
  v_estado text;
  v_det text;
  v_codigo bigint;
  v_valor numeric;
  v_prazo integer;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'credito_sombra_lote: exige READ COMMITTED' USING ERRCODE = '25000';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('credito_sombra_lote', 0)) THEN
    RETURN jsonb_build_object('status', 'ocupado');
  END IF;
  PERFORM public.credito_portao(v_lote::text);
  INSERT INTO public.credito_sombra_lote (id) VALUES (v_lote);

  -- (a) conciliação ANTES de avaliar (Codex P1): só fatos do Omie encerram reserva
  FOR r IN SELECT rs.id, rs.valor_brl, rs.company, rs.omie_codigo_cliente, rs.sales_order_id,
                  s.status AS st, s.omie_numero_pedido AS num
             FROM public.credito_sombra_reserva rs
             LEFT JOIN public.sales_orders s ON s.id = rs.sales_order_id
            WHERE rs.status = 'ativa' LOOP
    IF r.st = 'cancelado' THEN
      PERFORM public.credito_portao(r.id::text);
      UPDATE public.credito_sombra_reserva SET status = 'liberada', encerrada_em = now(),
             motivo_encerramento = 'pedido cancelado no Omie' WHERE id = r.id AND status = 'ativa';
      v_lib := v_lib + 1;
    ELSIF r.st = 'faturado'
          AND private.credito_sombra_titulos_pv(r.company, r.omie_codigo_cliente, r.num) >= r.valor_brl THEN
      PERFORM public.credito_portao(r.id::text);
      UPDATE public.credito_sombra_reserva SET status = 'transferida', encerrada_em = now(),
             motivo_encerramento = 'títulos do PV cobrem o compromisso' WHERE id = r.id AND status = 'ativa';
      v_tr := v_tr + 1;
    END IF;
  END LOOP;

  -- (b) candidatos: versão corrente de cada PV ainda sem decisão (valor ilegível não repete; erro até 3×)
  FOR c IN
    WITH base AS (
      SELECT s.id, s.account AS company, s.status, s.total, s.items, s.created_at, s.customer_user_id,
             (k.sales_order_id IS NOT NULL) AS carga,
             rv.id AS rev_id, rv.valor_brl AS rev_valor, rv.prazo_dias AS rev_prazo,
             rv.omie_codigo_cliente AS rev_codigo
        FROM public.sales_orders s
        LEFT JOIN public.credito_sombra_carga k ON k.sales_order_id = s.id
        LEFT JOIN LATERAL (SELECT ov.* FROM public.credito_operacao_revisao ov
                            WHERE ov.sales_order_id = s.id AND ov.company = s.account
                            ORDER BY ov.seq DESC LIMIT 1) rv ON true
       WHERE s.account IN ('oben','colacor')
         AND s.deleted_at IS NULL
         AND s.status NOT IN ('cancelado','rascunho','orcamento')
         AND (k.sales_order_id IS NULL OR k.aberto)
    ), cand AS (
      SELECT b.*,
             CASE WHEN b.rev_id IS NOT NULL THEN 'app' ELSE 'omie' END AS origem,
             CASE WHEN b.rev_id IS NOT NULL
                  THEN md5('app|' || b.rev_id::text)
                  ELSE md5(concat_ws('|', 'omie', b.company, b.customer_user_id::text, b.total::text, b.items::text))
             END AS md5
        FROM base b
    )
    SELECT x.* FROM cand x
     WHERE x.md5 IS DISTINCT FROM (SELECT d.conteudo_md5 FROM public.credito_sombra_decisao d
                                    WHERE d.sales_order_id = x.id AND d.company = x.company
                                    ORDER BY d.avaliado_em DESC, d.id LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM public.credito_sombra_tentativa t
                        WHERE t.sales_order_id = x.id AND t.company = x.company AND t.conteudo_md5 = x.md5
                          AND t.resultado IN ('valor_ausente','valor_parcial'))
       AND (SELECT count(*) FROM public.credito_sombra_tentativa t
             WHERE t.sales_order_id = x.id AND t.company = x.company AND t.conteudo_md5 = x.md5
               AND t.resultado = 'erro') < 3
     ORDER BY x.created_at, x.id
  LOOP
    IF v_n >= p_max OR clock_timestamp() - v_inicio > make_interval(secs => p_orcamento_seg) THEN
      v_pend := v_pend + 1;
      CONTINUE;
    END IF;
    v_n := v_n + 1;
    -- app: o valor é o da revisão (calculado no servidor, PR 3); importado: total + itens do espelho
    v_valor_ok := CASE WHEN c.origem = 'app'
                       THEN CASE WHEN c.rev_valor > 0 AND c.rev_valor < 1e12 THEN 'ok' ELSE 'valor_ausente' END
                       ELSE private.credito_sombra_valor(c.total, c.items) END;
    IF v_valor_ok <> 'ok' THEN
      v_id := gen_random_uuid();
      PERFORM public.credito_portao(v_id::text);
      INSERT INTO public.credito_sombra_tentativa (id, lote_id, sales_order_id, company, conteudo_md5, resultado)
      VALUES (v_id, v_lote, c.id, c.company, c.md5, v_valor_ok);
      v_pu := v_pu + 1;
      CONTINUE;
    END IF;
    BEGIN
      v_valor := CASE WHEN c.origem = 'app' THEN c.rev_valor ELSE c.total END;
      v_prazo := CASE WHEN c.origem = 'app' THEN c.rev_prazo END;   -- importado: prazo desconhecido
      IF c.origem = 'app' THEN
        v_codigo := c.rev_codigo;                                     -- devedor congelado na revisão
      ELSE
        SELECT CASE WHEN count(*) = 1 THEN min(m.omie_codigo_cliente) END INTO v_codigo
          FROM public.omie_customer_account_map m
         WHERE m.user_id = c.customer_user_id AND m.account = c.company;
      END IF;
      v_dec := private.credito_sombra_avaliar(c.id, c.company, v_codigo, v_valor, v_prazo);
      v_versao := CASE WHEN c.origem = 'app' THEN c.rev_id::text
                       ELSE 'omie:' || (1 + (SELECT count(*) FROM public.credito_sombra_decisao d
                                              WHERE d.sales_order_id = c.id AND d.company = c.company))::text END;
      v_dec_id := gen_random_uuid();
      PERFORM public.credito_portao(v_dec_id::text);
      INSERT INTO public.credito_sombra_decisao (
        id, lote_id, sales_order_id, company, origem, versao, conteudo_md5, omie_codigo_cliente,
        grupo_user_id, grupo_assinatura, valor_brl, prazo_dias, faixa, motivo, faixa_sem_prazo, motivo_sem_prazo,
        exposicao_titulos_brl, exposicao_reservas_brl, limite_brl, prazo_max_dias, limite_versao,
        piso, sync, carga_inicial, status_pedido, pedido_data_comercial)
      VALUES (
        v_dec_id, v_lote, c.id, c.company, c.origem, v_versao, c.md5, v_codigo,
        (v_dec ->> 'grupo_user_id')::uuid, v_dec ->> 'grupo_assinatura', v_valor, v_prazo,
        v_dec ->> 'faixa', v_dec ->> 'motivo', v_dec ->> 'faixa_sem_prazo', v_dec ->> 'motivo_sem_prazo',
        (v_dec ->> 'exposicao_titulos_brl')::numeric, (v_dec ->> 'exposicao_reservas_brl')::numeric,
        (v_dec ->> 'limite_brl')::numeric, (v_dec ->> 'prazo_max_dias')::integer, (v_dec ->> 'limite_versao')::integer,
        v_dec -> 'piso', v_dec -> 'sync', c.carga, c.status,
        (c.created_at AT TIME ZONE 'America/Sao_Paulo')::date);

      -- versão nova substitui a reserva anterior; o PV é real → reserva em QUALQUER faixa
      FOR r IN SELECT rs.id FROM public.credito_sombra_reserva rs
                WHERE rs.sales_order_id = c.id AND rs.company = c.company AND rs.status = 'ativa' LOOP
        PERFORM public.credito_portao(r.id::text);
        UPDATE public.credito_sombra_reserva SET status = 'substituida', encerrada_em = now(),
               motivo_encerramento = 'nova versão ' || v_versao WHERE id = r.id AND status = 'ativa';
      END LOOP;
      -- faturado também reserva: até o título chegar, o compromisso só existe aqui (a conciliação do
      -- próximo lote o transfere); sem par resolvido não há onde ancorar a reserva
      IF v_codigo IS NOT NULL THEN
        v_id := gen_random_uuid();
        PERFORM public.credito_portao(v_id::text);
        INSERT INTO public.credito_sombra_reserva (id, decisao_id, sales_order_id, company, omie_codigo_cliente,
                                                   grupo_user_id, valor_brl)
        VALUES (v_id, v_dec_id, c.id, c.company, v_codigo, (v_dec ->> 'grupo_user_id')::uuid, v_valor);
      END IF;
      v_av := v_av + 1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_estado = RETURNED_SQLSTATE, v_det = MESSAGE_TEXT;
      v_id := gen_random_uuid();
      PERFORM public.credito_portao(v_id::text);
      INSERT INTO public.credito_sombra_tentativa (id, lote_id, sales_order_id, company, conteudo_md5, resultado, detalhe)
      VALUES (v_id, v_lote, c.id, c.company, c.md5, 'erro', v_estado || ': ' || left(v_det, 300));
      v_er := v_er + 1;
    END;
  END LOOP;

  PERFORM public.credito_portao(v_lote::text);
  UPDATE public.credito_sombra_lote
     SET terminado_em = clock_timestamp(), avaliados = v_av, erros = v_er, pulados = v_pu,
         liberadas = v_lib, transferidas = v_tr, pendentes = v_pend, status = 'ok'
   WHERE id = v_lote;
  PERFORM public.credito_portao(NULL);
  RETURN jsonb_build_object('status', 'ok', 'lote_id', v_lote, 'avaliados', v_av, 'erros', v_er,
                            'pulados', v_pu, 'liberadas', v_lib, 'transferidas', v_tr, 'pendentes', v_pend);
END;
$$;

-- ── 6. ACL: nenhuma função da sombra é chamável de fora (só o dono — o pg_cron roda como postgres) ─
DO $acl$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS fn FROM pg_proc p
            WHERE p.pronamespace = 'private'::regnamespace AND p.proname LIKE 'credito_sombra_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', r.fn);
  END LOOP;
  -- default ACL pode ter dado EXECUTE a outros papéis (ex.: sandbox_exec_*): fora todos
  FOR r IN SELECT p.oid::regprocedure AS fn, a.grantee::regrole::text AS papel
             FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
            WHERE p.pronamespace = 'private'::regnamespace AND p.proname LIKE 'credito_sombra_%'
              AND a.grantee <> 0 AND a.grantee <> p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', r.fn, r.papel);
  END LOOP;
END
$acl$;

-- ── 7. Sensores (views security_invoker: leem com a RLS de quem consulta) ───────────────────
-- Última decisão por PV (a distribuição conta PV, não versão).
CREATE OR REPLACE VIEW public.credito_sombra_pv_atual WITH (security_invoker = on) AS
SELECT DISTINCT ON (d.sales_order_id, d.company) d.*
  FROM public.credito_sombra_decisao d
 ORDER BY d.sales_order_id, d.company, d.avaliado_em DESC, d.id;

CREATE OR REPLACE VIEW public.credito_sombra_saude WITH (security_invoker = on) AS
SELECT (SELECT ativado_em FROM public.credito_sombra_marco) AS ativado_em,
       (SELECT max(terminado_em) FROM public.credito_sombra_lote WHERE status = 'ok') AS ultimo_lote_ok,
       (SELECT count(*) FROM public.credito_sombra_lote WHERE status = 'rodando'
          AND iniciado_em < now() - interval '15 minutes') AS lotes_presos,
       (SELECT count(*) FROM public.credito_sombra_tentativa WHERE resultado = 'erro'
          AND criada_em > now() - interval '24 hours') AS erros_24h,
       (SELECT count(*) FROM public.credito_sombra_carga k JOIN public.sales_orders s ON s.id = k.sales_order_id
         WHERE k.aberto AND s.deleted_at IS NULL AND s.status NOT IN ('cancelado','rascunho','orcamento')
           AND NOT EXISTS (SELECT 1 FROM public.credito_sombra_decisao d WHERE d.sales_order_id = k.sales_order_id))
         AS carga_pendente,
       (SELECT count(*) FROM public.credito_sombra_reserva rs JOIN public.sales_orders s ON s.id = rs.sales_order_id
         WHERE rs.status = 'ativa' AND s.status = 'faturado') AS faturado_reserva_ativa,
       (SELECT count(*) FROM public.credito_sombra_reserva rs JOIN public.sales_orders s ON s.id = rs.sales_order_id
         WHERE rs.status = 'ativa' AND s.deleted_at IS NOT NULL) AS excluido_app_reserva_ativa;

-- default ACL do Supabase dá ALL a authenticated e INSERT a sandbox_exec_* também em VIEW: allowlist
DO $vacl$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT DISTINCT c.oid::regclass AS rel, a.grantee::regrole::text AS papel
             FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
            WHERE c.oid IN ('public.credito_sombra_pv_atual'::regclass, 'public.credito_sombra_saude'::regclass)
              AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
    EXECUTE format('REVOKE ALL ON %s FROM %s', r.rel, r.papel);
  END LOOP;
END
$vacl$;
REVOKE ALL ON public.credito_sombra_pv_atual, public.credito_sombra_saude FROM PUBLIC, anon;
GRANT SELECT ON public.credito_sombra_pv_atual, public.credito_sombra_saude TO authenticated, service_role;

-- ── 8. cron: a cada 10 min, deslocado do minuto cheio (fin-sync-continuacao roda em */10) ─────
DO $cron$
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'credito-sombra-lote-10min';
  PERFORM cron.schedule('credito-sombra-lote-10min', '3-59/10 * * * *',
                        'SELECT private.credito_sombra_lote(100, 45)');
END
$cron$;

-- ── 9. pós-condição ────────────────────────────────────────────────────────────────────────
DO $pos$
DECLARE
  v_n integer;
BEGIN
  IF (SELECT count(*) FROM _efetivo_antes) <> 2
     OR EXISTS (SELECT 1 FROM _efetivo_antes a JOIN pg_proc p ON p.oid = a.oid
                 WHERE md5(p.prosrc) <> a.corpo OR p.proacl::text IS DISTINCT FROM a.acl) THEN
    RAISE EXCEPTION 'POSCONDICAO credito-sombra: gate efetivo alterado';
  END IF;
  SELECT count(*) INTO v_n FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'credito\_sombra\_%' AND c.relkind = 'r'
     AND c.relrowsecurity;
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'POSCONDICAO credito-sombra: RLS em % de 6 tabelas', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'credito\_sombra\_%'
                AND a.grantee <> c.relowner AND a.privilege_type <> 'SELECT') THEN
    RAISE EXCEPTION 'POSCONDICAO credito-sombra: privilégio de escrita fora do dono';
  END IF;
  -- proacl NULL = default (EXECUTE a PUBLIC): o aclexplode não o veria — exige ACL explícito
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.pronamespace = 'private'::regnamespace AND p.proname LIKE 'credito\_sombra\_%'
         AND p.proacl IS NOT NULL) <> 6
     OR EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
                 WHERE p.pronamespace = 'private'::regnamespace AND p.proname LIKE 'credito\_sombra\_%'
                   AND a.grantee <> p.proowner) THEN
    RAISE EXCEPTION 'POSCONDICAO credito-sombra: EXECUTE de função da sombra fora do dono';
  END IF;
  IF (SELECT count(*) FROM pg_class c
       WHERE c.oid IN ('public.credito_sombra_pv_atual'::regclass, 'public.credito_sombra_saude'::regclass)
         AND c.reloptions @> ARRAY['security_invoker=on']) <> 2 THEN
    RAISE EXCEPTION 'POSCONDICAO credito-sombra: view sem security_invoker';
  END IF;
  IF (SELECT count(*) FROM public.credito_sombra_marco) <> 1
     OR EXISTS (SELECT 1 FROM public.sales_orders s
                 WHERE s.created_at < (SELECT ativado_em FROM public.credito_sombra_marco)
                   AND NOT EXISTS (SELECT 1 FROM public.credito_sombra_carga k WHERE k.sales_order_id = s.id)) THEN
    RAISE EXCEPTION 'POSCONDICAO credito-sombra: marco/inventário incompleto';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'credito-sombra-lote-10min' AND active
                                      AND username = 'postgres') <> 1 THEN
    RAISE EXCEPTION 'POSCONDICAO credito-sombra: cron ausente ou com outro dono (o lote só roda como o dono das funções)';
  END IF;
  RAISE NOTICE 'POSCONDICAO credito-sombra OK';
END
$pos$;
