-- ============================================================
-- Fila de cobrança com ESTADO e DONA + coorte congelada do vencido (plano Oben PME/PMR, Frente B, PR2)
-- Spec: docs/superpowers/specs/2026-10-31-oben-frente-b-pedido-cobranca-cet-design.md §3 + §7 (#8–#11)
--
-- O que nasce aqui (nada existe em prod; sem PRE anti-deriva):
--   1) cobranca_coorte + cobranca_coorte_titulo — a carteira vencida CONGELADA por TÍTULO no dia da
--      selagem (denominador do programa). Selada UMA vez por empresa (UNIQUE company); reaplicar não
--      acrescenta nem reabre. Fonte = v_ciclo_cr_titulos `vencida_aberta` (a MESMA régua do aviso no
--      pedido e da fila). "Recuperado" nunca é afirmado por saldo de cliente: cada título congelado
--      tem destino próprio (recebido / cancelado / renegociado / aberto) lido depois de fin_contas_receber.
--   2) cobranca_caso (1 aberto por par company+cliente; estado; dona), cobranca_promessa (identidade
--      própria, desfecho DERIVADO em leitura), cobranca_evento (append-only; contato é EVENTO, não estado).
--   3) RPCs SECDEF: cobranca_fila(p_company), cobranca_caso_registrar(p), cobranca_regua_hoje(p_company).
--      Gate: staff; visibilidade = dona do cliente (carteira) OU quem vê a carteira completa.
--      Sensor `cobranca.estado_mudou` gravado no outbox pelo próprio writer (chave = id do evento).
--
-- Caminho: `bun run db:aplicar supabase/migrations/20261031210000_cobranca_fila.sql` (sem envelope).
-- ⚠️ A selagem da coorte é IRREVERSÍVEL por desenho (é o denominador): pré-voo psql-ro com a contagem
--    do dia antes do apply; a postcondição confere cabeçalho × detalhe.
-- Prova PG17: db/test-cobranca-fila.sh.
-- ============================================================

-- ------------------------------------------------------------
-- 0) Dona do cliente: código Omie → usuário (proof-table do mapa) → carteira (owner elegível).
--    Sem mapa ou sem carteira ⇒ NULL (restrito à gestão; nunca se inventa dona).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cobranca_dona(p_company text, p_codigo bigint)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT ca.owner_user_id
    FROM public.omie_customer_account_map m
    JOIN public.carteira_assignments ca ON ca.customer_user_id = m.user_id AND ca.eligible
   WHERE m.account = p_company AND m.omie_codigo_cliente = p_codigo
   ORDER BY ca.updated_at DESC NULLS LAST
   LIMIT 1
$fn$;
-- authenticated PODE executar: as policies de caso/promessa/evento decidem pela dona ATUAL (carteira de hoje),
-- nao pela dona de abertura — ex-dona perde a leitura quando a carteira muda (achado Codex codigo PR2 #1).
REVOKE ALL ON FUNCTION public.cobranca_dona(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cobranca_dona(text, bigint) TO authenticated, service_role;

-- Quem pode agir sobre o par: dona OU carteira completa (gestor/master). Fail-closed no uid nulo.
CREATE OR REPLACE FUNCTION public.cobranca_pode_agir(p_uid uuid, p_company text, p_codigo bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  -- coalesce nos DOIS ramos: cliente sem dona dá `NULL = uid` ⇒ NULL, e `IF NOT NULL` não barra
  -- (fail-open silencioso — pego pela prova C3d). Sem dona ⇒ só a gestão age.
  SELECT p_uid IS NOT NULL AND (
    coalesce(private.pode_ver_carteira_completa(p_uid), false)
    OR coalesce(public.cobranca_dona(p_company, p_codigo) = p_uid, false)
  )
$fn$;
REVOKE ALL ON FUNCTION public.cobranca_pode_agir(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cobranca_pode_agir(uuid, text, bigint) TO service_role;

-- ------------------------------------------------------------
-- 1) Coorte congelada (cabeçalho + títulos)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cobranca_coorte (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben', 'colacor', 'colacor_sc')),
  corte_em date NOT NULL,
  selada_em timestamptz NOT NULL DEFAULT now(),
  n_titulos integer NOT NULL CHECK (n_titulos > 0),
  n_clientes integer NOT NULL CHECK (n_clientes > 0),
  saldo_total numeric NOT NULL CHECK (saldo_total <> 'NaN' AND saldo_total > 0 AND saldo_total < 100000000),
  fonte text NOT NULL,
  CONSTRAINT cobranca_coorte_uma_por_empresa UNIQUE (company)
);
CREATE TABLE IF NOT EXISTS public.cobranca_coorte_titulo (
  coorte_id uuid NOT NULL REFERENCES public.cobranca_coorte(id),
  company text NOT NULL,
  omie_codigo_lancamento bigint NOT NULL,
  omie_codigo_cliente bigint NOT NULL,
  nome_cliente text,
  saldo_inicial numeric NOT NULL CHECK (saldo_inicial <> 'NaN' AND saldo_inicial > 0 AND saldo_inicial < 100000000),
  data_vencimento date NOT NULL,
  dias_vencido_inicial integer NOT NULL CHECK (dias_vencido_inicial >= 0),
  PRIMARY KEY (coorte_id, omie_codigo_lancamento)
);
CREATE INDEX IF NOT EXISTS idx_cobranca_coorte_titulo_cliente ON public.cobranca_coorte_titulo (company, omie_codigo_cliente);

ALTER TABLE public.cobranca_coorte ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cobranca_coorte_titulo ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cobranca_coorte, public.cobranca_coorte_titulo FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cobranca_coorte, public.cobranca_coorte_titulo TO authenticated;
GRANT ALL ON TABLE public.cobranca_coorte, public.cobranca_coorte_titulo TO service_role;
-- Só gestão lê a coorte crua (a fila expõe o saldo inicial por cliente via RPC, já filtrado por dona).
DROP POLICY IF EXISTS "cobranca_coorte_select_gestao" ON public.cobranca_coorte;
CREATE POLICY "cobranca_coorte_select_gestao" ON public.cobranca_coorte FOR SELECT
  USING (coalesce((SELECT private.pode_ver_carteira_completa((SELECT auth.uid()))), false));
DROP POLICY IF EXISTS "cobranca_coorte_titulo_select_gestao" ON public.cobranca_coorte_titulo;
CREATE POLICY "cobranca_coorte_titulo_select_gestao" ON public.cobranca_coorte_titulo FOR SELECT
  USING (coalesce((SELECT private.pode_ver_carteira_completa((SELECT auth.uid()))), false));
DROP POLICY IF EXISTS "cobranca_coorte_service_all" ON public.cobranca_coorte;
CREATE POLICY "cobranca_coorte_service_all" ON public.cobranca_coorte FOR ALL USING ((SELECT auth.role()) = 'service_role');
DROP POLICY IF EXISTS "cobranca_coorte_titulo_service_all" ON public.cobranca_coorte_titulo;
CREATE POLICY "cobranca_coorte_titulo_service_all" ON public.cobranca_coorte_titulo FOR ALL USING ((SELECT auth.role()) = 'service_role');

-- Selagem: UMA vez por empresa, cabeçalho e títulos na mesma transação. Reaplicar = no-op.
DO $sela$
DECLARE
  v_company text;
  v_corte date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_id uuid;
  v_n int; v_cli int; v_saldo numeric;
BEGIN
  FOREACH v_company IN ARRAY ARRAY['oben'] LOOP
    IF EXISTS (SELECT 1 FROM public.cobranca_coorte c WHERE c.company = v_company) THEN
      CONTINUE;
    END IF;
    SELECT count(*), count(DISTINCT t.omie_codigo_cliente), coalesce(sum(t.saldo), 0)
      INTO v_n, v_cli, v_saldo
      FROM public.v_ciclo_cr_titulos t
     WHERE t.company = v_company AND t.situacao = 'vencida_aberta';
    IF v_n = 0 THEN
      RAISE EXCEPTION 'SELAGEM FALHOU: % sem titulo vencido na view — coorte vazia nao se sela', v_company;
    END IF;
    INSERT INTO public.cobranca_coorte (company, corte_em, n_titulos, n_clientes, saldo_total, fonte)
    VALUES (v_company, v_corte, v_n, v_cli, v_saldo, 'v_ciclo_cr_titulos vencida_aberta')
    RETURNING id INTO v_id;
    INSERT INTO public.cobranca_coorte_titulo (coorte_id, company, omie_codigo_lancamento, omie_codigo_cliente, nome_cliente, saldo_inicial, data_vencimento, dias_vencido_inicial)
    SELECT v_id, t.company, t.omie_codigo_lancamento, t.omie_codigo_cliente, t.nome_cliente, t.saldo, t.data_vencimento, greatest(coalesce(t.dias_vencido, 0), 0)
      FROM public.v_ciclo_cr_titulos t
     WHERE t.company = v_company AND t.situacao = 'vencida_aberta';
  END LOOP;
END
$sela$;

-- ------------------------------------------------------------
-- 2) Caso, promessa, evento
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cobranca_caso (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben', 'colacor', 'colacor_sc')),
  omie_codigo_cliente bigint NOT NULL CHECK (omie_codigo_cliente > 0),
  nome_cliente text,
  dona_user_id uuid,
  estado text NOT NULL DEFAULT 'a_contatar'
    CHECK (estado IN ('a_contatar', 'contatado', 'promessa', 'pago_informado', 'negociado', 'disputa')),
  proximo_contato_em date,
  nota_atual text,
  aberto_em timestamptz NOT NULL DEFAULT now(),
  aberto_por uuid NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_por uuid NOT NULL,
  fechado_em timestamptz,
  fechado_motivo text CHECK (fechado_motivo IS NULL OR fechado_motivo IN ('quitado', 'cancelado_gestao')),
  CONSTRAINT cobranca_caso_fechamento_coerente CHECK ((fechado_em IS NULL) = (fechado_motivo IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cobranca_caso_aberto_unico
  ON public.cobranca_caso (company, omie_codigo_cliente) WHERE fechado_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_cobranca_caso_dona ON public.cobranca_caso (dona_user_id) WHERE fechado_em IS NULL;

CREATE TABLE IF NOT EXISTS public.cobranca_promessa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caso_id uuid NOT NULL REFERENCES public.cobranca_caso(id),
  data_prometida date NOT NULL,
  valor numeric NOT NULL CHECK (valor <> 'NaN' AND valor > 0 AND valor < 100000000),
  saldo_na_criacao numeric NOT NULL CHECK (saldo_na_criacao <> 'NaN' AND saldo_na_criacao >= 0),
  criada_em timestamptz NOT NULL DEFAULT now(),
  criada_por uuid NOT NULL,
  substituida_em timestamptz
);
CREATE INDEX IF NOT EXISTS idx_cobranca_promessa_caso ON public.cobranca_promessa (caso_id, criada_em);

CREATE TABLE IF NOT EXISTS public.cobranca_evento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caso_id uuid NOT NULL REFERENCES public.cobranca_caso(id),
  tipo text NOT NULL CHECK (tipo IN ('abertura', 'estado', 'contato', 'whatsapp_aberto', 'promessa', 'nota', 'fechamento')),
  de_estado text,
  para_estado text,
  canal text CHECK (canal IS NULL OR canal IN ('whatsapp', 'telefone', 'email', 'presencial', 'sistema')),
  nota text,
  promessa_id uuid REFERENCES public.cobranca_promessa(id),
  autor uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cobranca_evento_caso ON public.cobranca_evento (caso_id, created_at);

ALTER TABLE public.cobranca_caso ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cobranca_promessa ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cobranca_evento ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cobranca_caso, public.cobranca_promessa, public.cobranca_evento FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cobranca_caso, public.cobranca_promessa, public.cobranca_evento TO authenticated;
GRANT ALL ON TABLE public.cobranca_caso, public.cobranca_promessa, public.cobranca_evento TO service_role;

-- Lê: dona do caso ou carteira completa. Escrita só pela RPC (1 writer).
DROP POLICY IF EXISTS "cobranca_caso_select" ON public.cobranca_caso;
CREATE POLICY "cobranca_caso_select" ON public.cobranca_caso FOR SELECT
  USING (coalesce(public.cobranca_dona(company, omie_codigo_cliente) = (SELECT auth.uid()), false)
         OR coalesce((SELECT private.pode_ver_carteira_completa((SELECT auth.uid()))), false));
DROP POLICY IF EXISTS "cobranca_caso_service_all" ON public.cobranca_caso;
CREATE POLICY "cobranca_caso_service_all" ON public.cobranca_caso FOR ALL USING ((SELECT auth.role()) = 'service_role');
DROP POLICY IF EXISTS "cobranca_promessa_select" ON public.cobranca_promessa;
CREATE POLICY "cobranca_promessa_select" ON public.cobranca_promessa FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.cobranca_caso c WHERE c.id = caso_id
                   AND (coalesce(public.cobranca_dona(c.company, c.omie_codigo_cliente) = (SELECT auth.uid()), false)
                        OR coalesce((SELECT private.pode_ver_carteira_completa((SELECT auth.uid()))), false))));
DROP POLICY IF EXISTS "cobranca_promessa_service_all" ON public.cobranca_promessa;
CREATE POLICY "cobranca_promessa_service_all" ON public.cobranca_promessa FOR ALL USING ((SELECT auth.role()) = 'service_role');
DROP POLICY IF EXISTS "cobranca_evento_select" ON public.cobranca_evento;
CREATE POLICY "cobranca_evento_select" ON public.cobranca_evento FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.cobranca_caso c WHERE c.id = caso_id
                   AND (coalesce(public.cobranca_dona(c.company, c.omie_codigo_cliente) = (SELECT auth.uid()), false)
                        OR coalesce((SELECT private.pode_ver_carteira_completa((SELECT auth.uid()))), false))));
DROP POLICY IF EXISTS "cobranca_evento_service_all" ON public.cobranca_evento;
CREATE POLICY "cobranca_evento_service_all" ON public.cobranca_evento FOR ALL USING ((SELECT auth.role()) = 'service_role');

-- Quitação com EVIDÊNCIA POSITIVA (achado Codex código PR2 #4): nenhum título aberto com saldo > 0 (qualquer
-- vencimento), nenhum título ambíguo/inválido, sync do CR da empresa fresco (≤ 24 h) e ≥ 1 título RECEBIDO.
-- Ausência de linha, saldo NULL ou sync velho NÃO é quitação.
CREATE OR REPLACE FUNCTION public.cobranca_quitacao_ok(p_company text, p_codigo bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT NOT EXISTS (
           SELECT 1 FROM public.fin_contas_receber r
            WHERE r.company = p_company AND r.omie_codigo_cliente = p_codigo
              AND r.status_titulo IS DISTINCT FROM 'CANCELADO'
              AND r.status_titulo NOT IN ('RECEBIDO', 'LIQUIDADO')
              AND (r.saldo IS NULL OR r.saldo <> r.saldo OR r.saldo >= 'Infinity' OR r.saldo > 0
                   OR r.status_titulo IS NULL OR r.status_titulo NOT IN ('A VENCER', 'VENCE HOJE', 'ATRASADO')))
     AND EXISTS (
           SELECT 1 FROM public.fin_contas_receber r
            WHERE r.company = p_company AND r.omie_codigo_cliente = p_codigo AND r.status_titulo IN ('RECEBIDO', 'LIQUIDADO'))
     AND EXISTS (
           SELECT 1 FROM public.fin_sync_log l
            WHERE l.status = 'complete' AND l.action IN ('sync_contas_receber', 'sync_all')
              AND p_company = ANY (l.companies) AND l.completed_at > now() - interval '24 hours')
$fn$;
REVOKE ALL ON FUNCTION public.cobranca_quitacao_ok(text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cobranca_quitacao_ok(text, bigint) TO service_role;

-- ------------------------------------------------------------
-- 3) RPC: a fila (vencido da view ∪ casos abertos), filtrada por quem pode ver
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cobranca_fila(p_company text)
RETURNS TABLE (
  company text, omie_codigo_cliente bigint, nome_cliente text,
  saldo_vencido numeric, n_vencidas integer, dias_vencido_max integer, faixa text,
  dona_user_id uuid, dona_nome text,
  caso_id uuid, estado text, proximo_contato_em date, nota_atual text, atualizado_em timestamptz,
  promessa_id uuid, promessa_data date, promessa_valor numeric, promessa_situacao text,
  saldo_inicial_coorte numeric, n_titulos_coorte integer, saldo_atual_coorte numeric, coorte_corte_em date,
  ultimo_contato_em timestamptz, n_contatos integer,
  pode_agir boolean, pode_quitar boolean, fechado_motivo text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_gestao boolean;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_uid AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'cobranca_fila: exige staff' USING ERRCODE = '42501';
  END IF;
  IF p_company IS NULL OR p_company NOT IN ('oben', 'colacor', 'colacor_sc') THEN
    RAISE EXCEPTION 'cobranca_fila: empresa invalida' USING ERRCODE = '22023';
  END IF;
  v_gestao := coalesce(private.pode_ver_carteira_completa(v_uid), false);

  RETURN QUERY
  WITH venc AS (
    SELECT v.company, v.omie_codigo_cliente, v.nome_cliente, v.saldo_vencido, v.n_vencidas, v.dias_vencido_max
      FROM public.v_ciclo_cliente_resumo v
     WHERE v.company = p_company AND v.n_vencidas > 0
  ),
  casos AS (
    -- o caso ABERTO do par; sem aberto, o último CANCELADO pela gestão (para a fila não reapresentar o mesmo
    -- estoque como `a_contatar` — achado Codex código PR2 #9); quitado não entra (vencido de novo = episódio novo)
    SELECT DISTINCT ON (c.company, c.omie_codigo_cliente) c.*
      FROM public.cobranca_caso c
     WHERE c.company = p_company AND (c.fechado_em IS NULL OR c.fechado_motivo = 'cancelado_gestao')
     ORDER BY c.company, c.omie_codigo_cliente, (c.fechado_em IS NULL) DESC, c.fechado_em DESC
  ),
  pares AS (
    SELECT coalesce(ve.company, ca.company) AS company,
           coalesce(ve.omie_codigo_cliente, ca.omie_codigo_cliente) AS omie_codigo_cliente,
           coalesce(ve.nome_cliente, ca.nome_cliente) AS nome_cliente,
           ve.saldo_vencido, ve.n_vencidas, ve.dias_vencido_max,
           CASE WHEN ca.fechado_em IS NULL THEN ca.id END AS caso_id,
           CASE WHEN ca.fechado_em IS NULL THEN ca.estado END AS estado,
           ca.fechado_motivo,
           ca.proximo_contato_em, ca.nota_atual, ca.atualizado_em
      FROM venc ve
      FULL OUTER JOIN casos ca ON ca.omie_codigo_cliente = ve.omie_codigo_cliente
  ),
  com_dona AS (
    -- dona = carteira de HOJE (a de abertura fica no caso só como auditoria)
    SELECT p.*, public.cobranca_dona(p.company, p.omie_codigo_cliente) AS dona
      FROM pares p
  ),
  prom AS (
    SELECT DISTINCT ON (pr.caso_id) pr.caso_id, pr.id, pr.data_prometida, pr.valor, pr.saldo_na_criacao
      FROM public.cobranca_promessa pr
     WHERE pr.substituida_em IS NULL
     ORDER BY pr.caso_id, pr.criada_em DESC
  ),
  coorte AS (
    -- atual pelos MESMOS títulos congelados (regra vencida_aberta); título que sumiu da fonte ⇒ atual NULL (desconhecido)
    SELECT ct.company, ct.omie_codigo_cliente, sum(ct.saldo_inicial) AS saldo_inicial, count(*)::int AS n_titulos,
           CASE WHEN bool_and(r.id IS NOT NULL) THEN
             coalesce(sum(CASE WHEN r.status_titulo IN ('ATRASADO', 'A VENCER', 'VENCE HOJE') AND r.saldo IS NOT NULL
                                    AND r.saldo <> 'NaN' AND r.saldo < 'Infinity' AND r.saldo > 0
                                    AND r.data_vencimento < v_hoje THEN r.saldo ELSE 0 END), 0)
           END AS saldo_atual,
           min(co.corte_em) AS corte_em
      FROM public.cobranca_coorte_titulo ct
      JOIN public.cobranca_coorte co ON co.id = ct.coorte_id
      LEFT JOIN public.fin_contas_receber r ON r.company = ct.company AND r.omie_codigo_lancamento = ct.omie_codigo_lancamento
     WHERE ct.company = p_company
     GROUP BY ct.company, ct.omie_codigo_cliente
  ),
  contatos AS (
    SELECT e.caso_id, max(e.created_at) AS ultimo, count(*)::int AS n
      FROM public.cobranca_evento e WHERE e.tipo = 'contato'
     GROUP BY e.caso_id
  )
  SELECT d.company, d.omie_codigo_cliente, d.nome_cliente,
         d.saldo_vencido, d.n_vencidas, d.dias_vencido_max,
         CASE WHEN d.dias_vencido_max IS NULL THEN NULL
              WHEN d.dias_vencido_max <= 45 THEN '<=45d'
              WHEN d.dias_vencido_max <= 90 THEN '46-90d'
              ELSE '>90d' END AS faixa,
         d.dona, pf.name AS dona_nome,
         d.caso_id,
         coalesce(d.estado, CASE WHEN d.fechado_motivo = 'cancelado_gestao' THEN 'cancelado_gestao' END, 'a_contatar') AS estado,
         d.proximo_contato_em, d.nota_atual, d.atualizado_em,
         pm.id, pm.data_prometida, pm.valor,
         CASE WHEN pm.id IS NULL THEN NULL
              -- `saldo_caiu` (não "cumprida"): o saldo vencido caiu ≥ o prometido — pode ser recebimento, cancelamento ou
              -- renegociação; recebimento só se afirma com baixa (achado Codex código PR2 #3). Saldo desconhecido ⇒ não afirma.
              WHEN d.saldo_vencido IS NULL THEN CASE WHEN pm.data_prometida < v_hoje THEN 'vencida' ELSE 'aberta' END
              WHEN d.saldo_vencido <= pm.saldo_na_criacao - pm.valor THEN 'saldo_caiu'
              WHEN pm.data_prometida < v_hoje THEN 'vencida'
              ELSE 'aberta' END AS promessa_situacao,
         co.saldo_inicial, co.n_titulos, co.saldo_atual, co.corte_em,
         ct.ultimo, coalesce(ct.n, 0),
         (v_gestao OR d.dona = v_uid) AS pode_agir,
         (d.caso_id IS NOT NULL AND public.cobranca_quitacao_ok(d.company, d.omie_codigo_cliente)) AS pode_quitar,
         d.fechado_motivo
    FROM com_dona d
    LEFT JOIN public.profiles pf ON pf.user_id = d.dona
    LEFT JOIN prom pm ON pm.caso_id = d.caso_id
    LEFT JOIN coorte co ON co.omie_codigo_cliente = d.omie_codigo_cliente
    LEFT JOIN contatos ct ON ct.caso_id = d.caso_id
   WHERE v_gestao OR d.dona = v_uid
   ORDER BY CASE WHEN d.dias_vencido_max IS NULL THEN 3 WHEN d.dias_vencido_max <= 45 THEN 0 WHEN d.dias_vencido_max <= 90 THEN 1 ELSE 2 END,
            d.saldo_vencido DESC NULLS LAST;
END;
$fn$;
REVOKE ALL ON FUNCTION public.cobranca_fila(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cobranca_fila(text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4) RPC: o writer único de caso/promessa/evento (+ sensor no outbox)
--    p = { company, omie_codigo_cliente, nome_cliente?, acao, para_estado?, canal?, nota?,
--          promessa_data?, promessa_valor?, proximo_contato_em?, fechado_motivo? }
--    acao ∈ estado | contato | whatsapp_aberto | promessa | nota | fechar
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cobranca_caso_registrar(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_company text := p ->> 'company';
  v_codigo bigint;
  v_acao text := p ->> 'acao';
  v_para text := nullif(btrim(coalesce(p ->> 'para_estado', '')), '');
  v_canal text := nullif(btrim(coalesce(p ->> 'canal', '')), '');
  v_nota text := nullif(btrim(coalesce(p ->> 'nota', '')), '');
  v_prox date;
  v_pdata date;
  v_pvalor numeric;
  v_fmotivo text := nullif(btrim(coalesce(p ->> 'fechado_motivo', '')), '');
  v_caso public.cobranca_caso%ROWTYPE;
  v_de text;
  v_saldo numeric;
  v_dias int;
  v_evento_id uuid;
  v_promessa_id uuid;
  v_gestao boolean;
  v_criou boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_uid AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'cobranca_caso_registrar: exige staff' USING ERRCODE = '42501';
  END IF;
  BEGIN
    v_codigo := (p ->> 'omie_codigo_cliente')::bigint;
    v_prox   := (p ->> 'proximo_contato_em')::date;
    v_pdata  := (p ->> 'promessa_data')::date;
    v_pvalor := (p ->> 'promessa_valor')::numeric;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN
    RAISE EXCEPTION 'cobranca_caso_registrar: payload invalido' USING ERRCODE = '22023';
  END;
  IF v_company IS NULL OR v_company NOT IN ('oben', 'colacor', 'colacor_sc') OR v_codigo IS NULL OR v_codigo <= 0
     OR v_acao IS NULL OR v_acao NOT IN ('estado', 'contato', 'whatsapp_aberto', 'promessa', 'nota', 'fechar')
     OR (v_canal IS NOT NULL AND v_canal NOT IN ('whatsapp', 'telefone', 'email', 'presencial', 'sistema'))
     OR (v_para IS NOT NULL AND v_para NOT IN ('a_contatar', 'contatado', 'promessa', 'pago_informado', 'negociado', 'disputa')) THEN
    RAISE EXCEPTION 'cobranca_caso_registrar: payload invalido' USING ERRCODE = '22023';
  END IF;
  IF NOT coalesce(public.cobranca_pode_agir(v_uid, v_company, v_codigo), false) THEN
    RAISE EXCEPTION 'cobranca_caso_registrar: nao e a dona do cliente nem ve a carteira completa' USING ERRCODE = '42501';
  END IF;
  v_gestao := coalesce(private.pode_ver_carteira_completa(v_uid), false);

  -- Caso aberto do par: cria se não existe (corrida: o índice parcial único decide; o perdedor relê).
  INSERT INTO public.cobranca_caso (company, omie_codigo_cliente, nome_cliente, dona_user_id, aberto_por, atualizado_por)
  VALUES (v_company, v_codigo, nullif(btrim(coalesce(p ->> 'nome_cliente', '')), ''),
          public.cobranca_dona(v_company, v_codigo), v_uid, v_uid)
  ON CONFLICT (company, omie_codigo_cliente) WHERE fechado_em IS NULL DO NOTHING
  RETURNING * INTO v_caso;
  IF v_caso.id IS NULL THEN
    SELECT * INTO v_caso FROM public.cobranca_caso c
     WHERE c.company = v_company AND c.omie_codigo_cliente = v_codigo AND c.fechado_em IS NULL
     FOR UPDATE;
  ELSE
    v_criou := true;
    INSERT INTO public.cobranca_evento (caso_id, tipo, para_estado, autor) VALUES (v_caso.id, 'abertura', v_caso.estado, v_uid);
  END IF;
  IF v_caso.id IS NULL THEN
    RAISE EXCEPTION 'cobranca_caso_registrar: caso indisponivel' USING ERRCODE = '40001';
  END IF;
  v_de := v_caso.estado;
  -- Dona refrescada pela carteira de HOJE a cada escrita (a de abertura fica no evento de abertura).
  UPDATE public.cobranca_caso SET dona_user_id = public.cobranca_dona(v_company, v_codigo) WHERE id = v_caso.id;
  -- Sair de DISPUTA exige nota em QUALQUER saída (estado, promessa, fechar) — não só na transição direta (Codex #8).
  IF v_de = 'disputa' AND v_acao IN ('estado', 'promessa', 'fechar') AND v_nota IS NULL THEN
    RAISE EXCEPTION 'cobranca_caso_registrar: sair de disputa exige nota' USING ERRCODE = '22023';
  END IF;

  IF v_acao = 'estado' THEN
    IF v_para IS NULL THEN
      RAISE EXCEPTION 'cobranca_caso_registrar: estado exige para_estado' USING ERRCODE = '22023';
    END IF;
    -- `promessa` só pela ação própria (carrega data e valor); sair de `disputa` exige nota.
    IF v_para = 'promessa' THEN
      RAISE EXCEPTION 'cobranca_caso_registrar: use acao=promessa' USING ERRCODE = '22023';
    END IF;
    IF v_para = v_de THEN
      RAISE EXCEPTION 'cobranca_caso_registrar: estado igual ao atual' USING ERRCODE = '22023';
    END IF;
    UPDATE public.cobranca_caso SET estado = v_para, nota_atual = coalesce(v_nota, nota_atual),
           proximo_contato_em = coalesce(v_prox, proximo_contato_em), atualizado_em = now(), atualizado_por = v_uid
     WHERE id = v_caso.id;
    INSERT INTO public.cobranca_evento (caso_id, tipo, de_estado, para_estado, canal, nota, autor)
    VALUES (v_caso.id, 'estado', v_de, v_para, v_canal, v_nota, v_uid) RETURNING id INTO v_evento_id;

  ELSIF v_acao = 'promessa' THEN
    IF v_pdata IS NULL OR v_pvalor IS NULL OR v_pvalor <> v_pvalor OR v_pvalor <= 0 OR v_pvalor >= 100000000
       OR v_pdata < (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
      RAISE EXCEPTION 'cobranca_caso_registrar: promessa exige data futura e valor finito > 0' USING ERRCODE = '22023';
    END IF;
    SELECT coalesce(v.saldo_vencido, 0) INTO v_saldo
      FROM public.v_ciclo_cliente_resumo v WHERE v.company = v_company AND v.omie_codigo_cliente = v_codigo;
    UPDATE public.cobranca_promessa SET substituida_em = now() WHERE caso_id = v_caso.id AND substituida_em IS NULL;
    INSERT INTO public.cobranca_promessa (caso_id, data_prometida, valor, saldo_na_criacao, criada_por)
    VALUES (v_caso.id, v_pdata, v_pvalor, coalesce(v_saldo, 0), v_uid) RETURNING id INTO v_promessa_id;
    UPDATE public.cobranca_caso SET estado = 'promessa', nota_atual = coalesce(v_nota, nota_atual),
           proximo_contato_em = coalesce(v_prox, v_pdata), atualizado_em = now(), atualizado_por = v_uid
     WHERE id = v_caso.id;
    INSERT INTO public.cobranca_evento (caso_id, tipo, de_estado, para_estado, canal, nota, promessa_id, autor)
    VALUES (v_caso.id, 'promessa', v_de, 'promessa', v_canal, v_nota, v_promessa_id, v_uid) RETURNING id INTO v_evento_id;
    v_para := 'promessa';

  ELSIF v_acao IN ('contato', 'whatsapp_aberto', 'nota') THEN
    -- Contato/nota são EVENTOS: não mudam estado (a promessa/disputa não some ao conversar).
    IF v_acao = 'contato' AND v_canal IS NULL THEN
      RAISE EXCEPTION 'cobranca_caso_registrar: contato exige canal' USING ERRCODE = '22023';
    END IF;
    IF v_acao = 'nota' AND v_nota IS NULL THEN
      RAISE EXCEPTION 'cobranca_caso_registrar: nota vazia' USING ERRCODE = '22023';
    END IF;
    UPDATE public.cobranca_caso SET nota_atual = coalesce(v_nota, nota_atual),
           proximo_contato_em = coalesce(v_prox, proximo_contato_em), atualizado_em = now(), atualizado_por = v_uid
     WHERE id = v_caso.id;
    INSERT INTO public.cobranca_evento (caso_id, tipo, canal, nota, autor)
    VALUES (v_caso.id, v_acao, CASE WHEN v_acao = 'whatsapp_aberto' THEN 'whatsapp' ELSE v_canal END, v_nota, v_uid)
    RETURNING id INTO v_evento_id;

  ELSIF v_acao = 'fechar' THEN
    -- `quitado` só quando a view NÃO vê mais vencido (conciliação pelo Omie, não pela palavra);
    -- `cancelado_gestao` só para quem vê a carteira completa, com nota.
    IF v_fmotivo IS NULL OR v_fmotivo NOT IN ('quitado', 'cancelado_gestao') THEN
      RAISE EXCEPTION 'cobranca_caso_registrar: fechar exige motivo quitado|cancelado_gestao' USING ERRCODE = '22023';
    END IF;
    IF v_fmotivo = 'quitado' THEN
      -- Evidência POSITIVA: sem título aberto/ambíguo/inválido, sync fresco e ≥ 1 recebido. Ausência não é quitação.
      IF NOT coalesce(public.cobranca_quitacao_ok(v_company, v_codigo), false) THEN
        RAISE EXCEPTION 'cobranca_caso_registrar: sem evidencia de quitacao (titulo aberto/ambiguo, sync velho ou nenhum recebido); informe pago_informado e aguarde a baixa'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NOT v_gestao OR v_nota IS NULL THEN
      RAISE EXCEPTION 'cobranca_caso_registrar: cancelar exige gestao e nota' USING ERRCODE = '42501';
    END IF;
    UPDATE public.cobranca_caso SET fechado_em = now(), fechado_motivo = v_fmotivo, nota_atual = coalesce(v_nota, nota_atual),
           atualizado_em = now(), atualizado_por = v_uid
     WHERE id = v_caso.id;
    INSERT INTO public.cobranca_evento (caso_id, tipo, de_estado, para_estado, nota, autor)
    VALUES (v_caso.id, 'fechamento', v_de, v_fmotivo, v_nota, v_uid) RETURNING id INTO v_evento_id;
    v_para := v_fmotivo;
  END IF;

  -- Sensor: só mudança de ESTADO (estado/promessa/fechar) vira `cobranca.estado_mudou`.
  IF v_acao IN ('estado', 'promessa', 'fechar') THEN
    SELECT v.dias_vencido_max INTO v_dias
      FROM public.v_ciclo_cliente_resumo v WHERE v.company = v_company AND v.omie_codigo_cliente = v_codigo;
    INSERT INTO public.analytics_outbox (evento, distinct_id, user_id, props, chave_dedup)
    VALUES ('cobranca.estado_mudou', v_uid::text, v_uid,
            jsonb_build_object('company', v_company, 'de', v_de, 'para', v_para, 'canal', v_canal,
                               'faixa', CASE WHEN v_dias IS NULL THEN NULL WHEN v_dias <= 45 THEN '<=45d'
                                             WHEN v_dias <= 90 THEN '46-90d' ELSE '>90d' END,
                               'caso_novo', v_criou),
            'ledger:cobranca.estado_mudou:' || v_evento_id::text)
    ON CONFLICT (chave_dedup) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('caso_id', v_caso.id, 'evento_id', v_evento_id, 'promessa_id', v_promessa_id,
                            'estado', coalesce(v_para, v_de), 'caso_novo', v_criou);
END;
$fn$;
REVOKE ALL ON FUNCTION public.cobranca_caso_registrar(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cobranca_caso_registrar(jsonb) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5) RPC: régua do dia — D−2 (lembrete PREVENTIVO, fora do estoque vencido), D+1 e D+7 (vencidos).
--    Devolve telefone (profiles do usuário do mapa) para o botão WhatsApp; só a dona/gestão vê.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cobranca_regua_hoje(p_company text)
RETURNS TABLE (
  marco text, company text, omie_codigo_cliente bigint, nome_cliente text,
  omie_codigo_lancamento bigint, numero_documento text, data_vencimento date, saldo numeric,
  telefone text, dona_user_id uuid, caso_id uuid, estado text, pode_agir boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_gestao boolean;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_uid AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'cobranca_regua_hoje: exige staff' USING ERRCODE = '42501';
  END IF;
  IF p_company IS NULL OR p_company NOT IN ('oben', 'colacor', 'colacor_sc') THEN
    RAISE EXCEPTION 'cobranca_regua_hoje: empresa invalida' USING ERRCODE = '22023';
  END IF;
  v_gestao := coalesce(private.pode_ver_carteira_completa(v_uid), false);

  RETURN QUERY
  WITH tit AS (
    SELECT CASE WHEN r.data_vencimento = v_hoje + 2 THEN 'D-2'
                WHEN r.data_vencimento = v_hoje - 1 THEN 'D+1'
                WHEN r.data_vencimento = v_hoje - 7 THEN 'D+7' END AS marco,
           r.company, r.omie_codigo_cliente, r.nome_cliente, r.omie_codigo_lancamento,
           coalesce(nullif(btrim(r.numero_documento_fiscal), ''), nullif(btrim(r.numero_documento), '')) AS numero_documento,
           r.data_vencimento, r.saldo
      FROM public.fin_contas_receber r
     WHERE r.company = p_company
       AND r.data_vencimento IN (v_hoje + 2, v_hoje - 1, v_hoje - 7)
       AND r.saldo IS NOT NULL AND r.saldo <> 'NaN' AND r.saldo < 'Infinity' AND r.saldo > 0
       AND r.valor_documento IS NOT NULL AND r.valor_documento > 0 AND r.valor_documento < 'Infinity'
       AND r.data_emissao IS NOT NULL AND r.data_vencimento >= r.data_emissao
       AND r.omie_codigo_cliente IS NOT NULL
       -- D−2: a vencer (status nativo). D+1/D+7: a MESMA régua `vencida_aberta` da view.
       AND ((r.data_vencimento = v_hoje + 2 AND r.status_titulo IN ('A VENCER', 'VENCE HOJE'))
            OR (r.data_vencimento < v_hoje AND r.status_titulo IN ('ATRASADO', 'A VENCER', 'VENCE HOJE')))
  ),
  com_dona AS (
    SELECT t.*, public.cobranca_dona(t.company, t.omie_codigo_cliente) AS dona,
           (SELECT nullif(btrim(pf.phone), '') FROM public.omie_customer_account_map m
              JOIN public.profiles pf ON pf.user_id = m.user_id
             WHERE m.account = t.company AND m.omie_codigo_cliente = t.omie_codigo_cliente
             ORDER BY pf.updated_at DESC NULLS LAST LIMIT 1) AS telefone
      FROM tit t
  )
  SELECT d.marco, d.company, d.omie_codigo_cliente, d.nome_cliente, d.omie_codigo_lancamento, d.numero_documento,
         d.data_vencimento, d.saldo, d.telefone, d.dona, c.id, c.estado, (v_gestao OR d.dona = v_uid)
    FROM com_dona d
    LEFT JOIN public.cobranca_caso c ON c.company = d.company AND c.omie_codigo_cliente = d.omie_codigo_cliente AND c.fechado_em IS NULL
   WHERE v_gestao OR d.dona = v_uid
   ORDER BY CASE d.marco WHEN 'D+7' THEN 0 WHEN 'D+1' THEN 1 ELSE 2 END, d.saldo DESC;
END;
$fn$;
REVOKE ALL ON FUNCTION public.cobranca_regua_hoje(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cobranca_regua_hoje(text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Postcondição
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_fila oid := to_regprocedure('public.cobranca_fila(text)');
  v_reg  oid := to_regprocedure('public.cobranca_caso_registrar(jsonb)');
  v_reg2 oid := to_regprocedure('public.cobranca_regua_hoje(text)');
  v_dona oid := to_regprocedure('public.cobranca_dona(text,bigint)');
  v_pode oid := to_regprocedure('public.cobranca_pode_agir(uuid,text,bigint)');
  v_cab record;
  v_det record;
  t text;
BEGIN
  IF v_fila IS NULL OR v_reg IS NULL OR v_reg2 IS NULL OR v_dona IS NULL OR v_pode IS NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: RPC ausente (fila=%, registrar=%, regua=%, dona=%, pode=%)', v_fila, v_reg, v_reg2, v_dona, v_pode;
  END IF;
  IF has_function_privilege('anon', v_fila, 'EXECUTE') OR has_function_privilege('public', v_fila, 'EXECUTE')
     OR has_function_privilege('anon', v_reg, 'EXECUTE') OR has_function_privilege('public', v_reg, 'EXECUTE')
     OR has_function_privilege('anon', v_reg2, 'EXECUTE') OR has_function_privilege('public', v_reg2, 'EXECUTE')
     OR has_function_privilege('anon', v_dona, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_dona, 'EXECUTE')
     OR has_function_privilege('authenticated', v_pode, 'EXECUTE')
     OR to_regprocedure('public.cobranca_quitacao_ok(text,bigint)') IS NULL
     OR has_function_privilege('authenticated', 'public.cobranca_quitacao_ok(text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: ACL errada (anon/PUBLIC nas RPCs humanas; cobranca_dona precisa de EXECUTE p/ authenticated — as policies a chamam; pode_agir/quitacao fechados)';
  END IF;
  FOREACH t IN ARRAY ARRAY['cobranca_coorte', 'cobranca_coorte_titulo', 'cobranca_caso', 'cobranca_promessa', 'cobranca_evento'] LOOP
    IF to_regclass('public.' || t) IS NULL
       OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = ('public.' || t)::regclass)
       OR has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       OR has_table_privilege('anon', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'P3 FALHOU: tabela % ausente, sem RLS, com escrita para authenticated ou leitura para anon', t;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_cobranca_caso_aberto_unico' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%fechado_em IS NULL%') <> 1 THEN
    RAISE EXCEPTION 'P4 FALHOU: indice parcial unico do caso aberto ausente — dois casos abertos por cliente';
  END IF;
  -- Coorte da oben selada e CONSISTENTE (cabeçalho = detalhe).
  SELECT c.id, c.n_titulos, c.n_clientes, c.saldo_total INTO v_cab FROM public.cobranca_coorte c WHERE c.company = 'oben';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'P5 FALHOU: coorte da oben nao selada';
  END IF;
  SELECT count(*) AS n, count(DISTINCT ct.omie_codigo_cliente) AS cli, coalesce(sum(ct.saldo_inicial), 0) AS saldo INTO v_det
    FROM public.cobranca_coorte_titulo ct WHERE ct.coorte_id = v_cab.id;
  IF v_det.n IS DISTINCT FROM v_cab.n_titulos OR v_det.cli IS DISTINCT FROM v_cab.n_clientes OR v_det.saldo IS DISTINCT FROM v_cab.saldo_total THEN
    RAISE EXCEPTION 'P6 FALHOU: coorte oben inconsistente — cabecalho %/%/% vs detalhe %/%/%',
      v_cab.n_titulos, v_cab.n_clientes, v_cab.saldo_total, v_det.n, v_det.cli, v_det.saldo;
  END IF;
  RAISE NOTICE 'cobranca_fila: 5 tabelas com RLS e 1 writer, 3 RPCs fechadas a anon/PUBLIC, coorte oben selada (% titulos, R$ %) — OK', v_cab.n_titulos, v_cab.saldo_total;
END
$post$;
