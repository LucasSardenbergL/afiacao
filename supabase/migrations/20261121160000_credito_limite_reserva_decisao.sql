-- ============================================================
-- Crédito-IA — PR 2: banco do limite, da reserva e da decisão (SEM efeito em pedido).
-- Spec: docs/superpowers/specs/2026-11-20-credito-ia-design.md §9 (Codex) e §10 (Lucas).
-- Plano: docs/superpowers/plans/2026-11-20-credito-ia.md — seção "PR 2".
--
-- Nada chama as RPCs daqui até o PR 5 (modo sombra). Até lá vale só o piso do PR 1.
--
-- Invariantes:
--  * Cada real comprometido ocupa o limite do GRUPO uma vez: título aberto OU reserva ativa.
--  * Reserva é transacional: pg_advisory_xact_lock por RAIZ do grupo (2×R$7k com R$10k → 1🟢 + 1🟡).
--  * Ausente ≠ zero: título aberto com saldo NULL → 🟡 exposicao_indeterminada; prazo NULL → 🟡.
--  * Solicitar ≠ autorizar: a solicitação nasce no gate (🟡); a autorização é registro SEPARADO,
--    só por RPC com private.cap_credito_escrever + allowlist credito_aprovador (1 linha: o Lucas).
--  * Autorização de limite NÃO cobre o piso (vencido > 60 d → 🔴, exceção do piso é a de hoje).
--  * Escrita só pelas RPCs: REVOKE de anon/authenticated/service_role + trigger com portão GUC
--    `credito.portao` = id da linha (PostgREST cru, edge com service_role e SQL na mão não escrevem).
--
-- Prova PG17: db/test-credito-limite-reserva.sh (asserts + 2 sessões concorrentes + falsificação).
-- Reversão: DROP das tabelas/funções novas (sem dado de negócio até o PR 4).
-- ============================================================

-- ── 0. Guarda de escrita (trigger genérico) ─────────────────────────────────────────────────
-- TG_ARGV[0] = coluna-chave · [1] = colunas mutáveis no UPDATE (CSV; ausente = append-only)
-- · [2] = status exigido no OLD para o UPDATE (linha já encerrada não muda).
CREATE OR REPLACE FUNCTION public.credito_guarda_escrita()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_portao text := nullif(current_setting('credito.portao', true), '');
  v_mutaveis text[];
  v_linha jsonb;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION '%: TRUNCATE recusado (crédito é trilha de auditoria)', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME <> 'credito_aprovador' THEN
    RAISE EXCEPTION '%: DELETE recusado (trilha de crédito)', TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;
  v_linha := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF v_portao IS NULL OR v_portao IS DISTINCT FROM (v_linha ->> TG_ARGV[0]) THEN
    RAISE EXCEPTION '%: escrita só pelas RPCs de crédito (portão ausente ou de outra linha)', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_NARGS < 2 THEN
      RAISE EXCEPTION '%: tabela append-only (UPDATE recusado)', TG_TABLE_NAME USING ERRCODE = '42501';
    END IF;
    v_mutaveis := string_to_array(TG_ARGV[1], ',');
    IF (to_jsonb(NEW) - v_mutaveis) IS DISTINCT FROM (to_jsonb(OLD) - v_mutaveis) THEN
      RAISE EXCEPTION '%: UPDATE só pode mudar %', TG_TABLE_NAME, TG_ARGV[1] USING ERRCODE = '42501';
    END IF;
    IF TG_NARGS >= 3 AND (to_jsonb(OLD) ->> 'status') IS DISTINCT FROM TG_ARGV[2] THEN
      RAISE EXCEPTION '%: linha já encerrada (status %) não muda', TG_TABLE_NAME, to_jsonb(OLD) ->> 'status'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION public.credito_guarda_escrita() FROM PUBLIC, anon, authenticated;

-- Abre o portão para UMA linha (só dentro das RPCs SECURITY DEFINER; is_local = fim da transação).
CREATE OR REPLACE FUNCTION public.credito_portao(p_chave text)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = public
AS $$ SELECT set_config('credito.portao', COALESCE(p_chave, ''), true); $$;
REVOKE ALL ON FUNCTION public.credito_portao(text) FROM PUBLIC, anon, authenticated, service_role;

-- ── 1. Tabelas ─────────────────────────────────────────────────────────────────────────────
-- Allowlist de aprovador de crédito. 1 linha: o Lucas (decisão do founder, spec §10).
CREATE TABLE IF NOT EXISTS public.credito_aprovador (
  user_id uuid PRIMARY KEY,
  motivo text NOT NULL,
  incluido_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.credito_limite_proposta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grupo_user_id uuid NOT NULL,
  grupo_assinatura text NOT NULL,
  limite_versao_base integer,                     -- versão do vigente quando foi proposta (NULL = não havia)
  limite_sugerido_brl numeric NOT NULL CHECK (limite_sugerido_brl >= 0 AND limite_sugerido_brl < 1e12),
  prazo_max_dias integer NOT NULL CHECK (prazo_max_dias BETWEEN 0 AND 365),
  risco text NOT NULL CHECK (risco IN ('baixo','medio','alto','sem_evidencia')),
  confianca numeric CHECK (confianca IS NULL OR confianca BETWEEN 0 AND 1),
  ficha jsonb NOT NULL,
  saida_ia jsonb,
  travas jsonb,
  modelo text,
  versao_politica text,
  ficha_calculada_em timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente','aprovada','recusada','expirada')),
  decidido_por uuid,
  decidido_em timestamptz,
  motivo_decisao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'pendente') = (decidido_em IS NULL))
);
CREATE INDEX IF NOT EXISTS credito_limite_proposta_grupo_idx
  ON public.credito_limite_proposta (grupo_user_id, status, created_at DESC);

-- Limite VIGENTE por grupo (raiz canônica). 1 writer: credito_aprovar_proposta.
CREATE TABLE IF NOT EXISTS public.credito_limite (
  grupo_user_id uuid PRIMARY KEY,
  limite_brl numeric NOT NULL CHECK (limite_brl >= 0 AND limite_brl < 1e12),
  prazo_max_dias integer NOT NULL CHECK (prazo_max_dias BETWEEN 0 AND 365),
  risco text NOT NULL CHECK (risco IN ('baixo','medio','alto','sem_evidencia')),
  versao integer NOT NULL CHECK (versao >= 1),
  grupo_assinatura text NOT NULL,
  ficha_calculada_em timestamptz NOT NULL,
  origem_proposta_id uuid NOT NULL REFERENCES public.credito_limite_proposta(id),
  aprovado_por uuid NOT NULL,
  vigente_desde timestamptz NOT NULL DEFAULT now()
);

-- Decisão por pedido × empresa × revisão. Append-only.
CREATE TABLE IF NOT EXISTS public.credito_decisao_pedido (
  id uuid PRIMARY KEY,
  sales_order_id uuid NOT NULL,                   -- sem FK: apagar orçamento não pode esbarrar na trilha
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  omie_codigo_cliente bigint,
  modo text NOT NULL CHECK (modo IN ('sombra','efetivo')),  -- sombra (PR 5) nunca soma no efetivo
  grupo_user_id uuid,
  grupo_assinatura text,
  revisao text NOT NULL,
  valor_brl numeric NOT NULL CHECK (valor_brl > 0 AND valor_brl < 1e12),
  prazo_dias integer,
  faixa text NOT NULL CHECK (faixa IN ('verde','amarelo','vermelho')),
  motivo text NOT NULL CHECK (motivo IN (
    'piso_vencido_60d','piso_indeterminado','sem_grupo','grupo_conflito','reserva_existente','autorizado',
    'sem_limite','grupo_mudou','limite_desatualizado','risco_alto','risco_sem_evidencia',
    'prazo_ilegivel','prazo_acima','exposicao_indeterminada','estoura_limite','dentro_limite')),
  exposicao_titulos_brl numeric,                  -- NULL = não calculada (sem grupo / piso)
  exposicao_reservas_brl numeric,
  reserva_anterior_brl numeric,
  limite_brl numeric,
  prazo_max_dias integer,
  limite_versao integer,
  autorizacao_id uuid,
  piso jsonb NOT NULL,
  solicitante uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credito_decisao_pedido_pedido_idx
  ON public.credito_decisao_pedido (sales_order_id, company, created_at DESC);

CREATE TABLE IF NOT EXISTS public.credito_reserva (
  id uuid PRIMARY KEY,
  decisao_id uuid NOT NULL REFERENCES public.credito_decisao_pedido(id),
  sales_order_id uuid NOT NULL,
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  omie_codigo_cliente bigint NOT NULL,            -- a exposição soma reservas pelo PAR (robusto a troca de raiz)
  modo text NOT NULL CHECK (modo IN ('sombra','efetivo')),
  grupo_user_id uuid NOT NULL,
  revisao text NOT NULL,
  valor_brl numeric NOT NULL CHECK (valor_brl > 0 AND valor_brl < 1e12),
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','substituida','transferida','liberada')),
  encerrada_em timestamptz,
  motivo_encerramento text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'ativa') = (encerrada_em IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS credito_reserva_uma_ativa_por_pedido
  ON public.credito_reserva (sales_order_id, company, modo) WHERE status = 'ativa';
CREATE INDEX IF NOT EXISTS credito_reserva_par_ativa_idx
  ON public.credito_reserva (company, omie_codigo_cliente, modo) WHERE status = 'ativa';
CREATE INDEX IF NOT EXISTS credito_reserva_revisao_idx
  ON public.credito_reserva (sales_order_id, company, modo, revisao);

-- Solicitação de aprovação: nasce no 🟡 EFETIVO que o aprovador consegue resolver (pendência
-- cadastral — sem_grupo/grupo_conflito/piso_indeterminado — não entra). NÃO autoriza nada.
CREATE TABLE IF NOT EXISTS public.credito_solicitacao (
  id uuid PRIMARY KEY,
  decisao_id uuid NOT NULL REFERENCES public.credito_decisao_pedido(id),
  sales_order_id uuid NOT NULL,
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  revisao text NOT NULL,
  valor_brl numeric NOT NULL CHECK (valor_brl > 0 AND valor_brl < 1e12),
  prazo_dias integer,
  motivo text NOT NULL,
  status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','autorizada','recusada','cancelada')),
  decidida_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'aberta') = (decidida_em IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS credito_solicitacao_uma_aberta
  ON public.credito_solicitacao (sales_order_id, company, revisao) WHERE status = 'aberta';

-- Autorização: registro SEPARADO, 1 por solicitação, amarrado a revisão/valor/prazo/validade.
CREATE TABLE IF NOT EXISTS public.credito_autorizacao (
  id uuid PRIMARY KEY,
  solicitacao_id uuid NOT NULL UNIQUE REFERENCES public.credito_solicitacao(id),
  autorizada boolean NOT NULL,
  revisao text NOT NULL,
  valor_max_brl numeric NOT NULL CHECK (valor_max_brl > 0 AND valor_max_brl < 1e12),
  prazo_max_dias integer,                         -- NULL = aceitou o prazo (ilegível) DESTA revisão
  motivo text NOT NULL CHECK (length(btrim(motivo)) >= 3),
  autorizado_por uuid NOT NULL,
  valido_ate timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── 2. RLS, grants e guardas ───────────────────────────────────────────────────────────────
DO $rls$
DECLARE
  t text;
  r record;
BEGIN
  FOREACH t IN ARRAY ARRAY['credito_aprovador','credito_limite_proposta','credito_limite',
                           'credito_decisao_pedido','credito_reserva','credito_solicitacao',
                           'credito_autorizacao'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    -- fecho por ALLOWLIST (P0 Codex diff): o default ACL de public dá INSERT também a
    -- sandbox_exec* (builder do Lovable, BYPASSRLS). Sai a escrita de TODO grantee que não é o dono.
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', t);
    FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
               FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.oid = ('public.' || t)::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.%I FROM %s', t, r.papel);
      IF r.papel NOT IN ('authenticated', 'service_role', 'claude_ro') THEN
        EXECUTE format('REVOKE SELECT ON public.%I FROM %s', t, r.papel);
      END IF;
    END LOOP;
    EXECUTE format('DROP TRIGGER IF EXISTS credito_guarda_truncate ON public.%I', t);
    EXECUTE format('CREATE TRIGGER credito_guarda_truncate BEFORE TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION public.credito_guarda_escrita(''id'')', t);
  END LOOP;

  -- allowlist: nem SELECT para authenticated (só as RPCs leem)
  REVOKE ALL ON public.credito_aprovador FROM authenticated;

  -- leitura: gestor/master (pode_ver_carteira_completa), InitPlan 1×
  FOREACH t IN ARRAY ARRAY['credito_limite_proposta','credito_limite','credito_decisao_pedido',
                           'credito_reserva','credito_solicitacao','credito_autorizacao'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_gestor', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
                   'USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))))',
                   t || '_select_gestor', t);
  END LOOP;

  -- trigger de linha: (tabela, chave, mutáveis, status aberto)
  FOR r IN SELECT * FROM (VALUES
      ('credito_aprovador',       'user_id',       NULL, NULL),
      ('credito_limite_proposta', 'id',            'status,decidido_por,decidido_em,motivo_decisao', 'pendente'),
      ('credito_limite',          'grupo_user_id', 'limite_brl,prazo_max_dias,risco,versao,grupo_assinatura,ficha_calculada_em,origem_proposta_id,aprovado_por,vigente_desde', NULL),
      ('credito_decisao_pedido',  'id',            NULL, NULL),
      ('credito_reserva',         'id',            'status,encerrada_em,motivo_encerramento', 'ativa'),
      ('credito_solicitacao',     'id',            'status,decidida_em', 'aberta'),
      ('credito_autorizacao',     'id',            NULL, NULL)
    ) v(tabela, chave, mutaveis, aberto) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS credito_guarda_linha ON public.%I', r.tabela);
    EXECUTE format('CREATE TRIGGER credito_guarda_linha BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.credito_guarda_escrita(%s)',
                   r.tabela,
                   concat_ws(', ', quote_literal(r.chave), quote_literal(r.mutaveis), quote_literal(r.aberto)));
  END LOOP;
END
$rls$;

-- A allowlist: 1 linha, o Lucas (único master em prod, psql-ro 2026-11-21). Idempotente.
DO $allow$
BEGIN
  PERFORM public.credito_portao('414a9727-ad1d-4998-914e-9c6ccf26cf50');
  INSERT INTO public.credito_aprovador (user_id, motivo)
  VALUES ('414a9727-ad1d-4998-914e-9c6ccf26cf50', 'founder — único aprovador de crédito (spec crédito-IA §10)')
  ON CONFLICT (user_id) DO NOTHING;
  PERFORM public.credito_portao(NULL);
END
$allow$;

-- ── 3. Identidade do grupo ─────────────────────────────────────────────────────────────────
-- Raiz = dono ÚNICO do par comprovado (mesmo eixo do PR 1), resolvido para o canônico.
CREATE OR REPLACE FUNCTION public.credito_grupo_raiz(p_company text, p_codigo bigint)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_donos uuid[];
  v_status text;
  v_canon uuid;
  v_raiz uuid;
BEGIN
  IF p_company IS NULL OR p_codigo IS NULL OR p_codigo <= 0 THEN
    RETURN jsonb_build_object('raiz', null, 'motivo', 'sem_grupo');
  END IF;
  SELECT array_agg(DISTINCT m.user_id) INTO v_donos
    FROM public.omie_customer_account_map m
   WHERE m.account = p_company AND m.omie_codigo_cliente = p_codigo;
  IF COALESCE(cardinality(v_donos), 0) <> 1 THEN
    RETURN jsonb_build_object('raiz', null, 'motivo', 'sem_grupo');
  END IF;
  SELECT a.status, a.canonical_user_id INTO v_status, v_canon
    FROM public.customer_canonical_alias a WHERE a.alias_user_id = v_donos[1];
  IF v_status = 'conflict' THEN
    RETURN jsonb_build_object('raiz', null, 'motivo', 'grupo_conflito');
  END IF;
  v_raiz := CASE WHEN v_status = 'active' THEN v_canon ELSE v_donos[1] END;
  -- conflito em qualquer membro, ou cadeia (a raiz é ela mesma alias) → não adivinha
  IF EXISTS (SELECT 1 FROM public.customer_canonical_alias a
              WHERE a.canonical_user_id = v_raiz AND a.status = 'conflict')
     OR EXISTS (SELECT 1 FROM public.customer_canonical_alias a
                 WHERE a.alias_user_id = v_raiz AND a.status = 'active') THEN
    RETURN jsonb_build_object('raiz', null, 'motivo', 'grupo_conflito');
  END IF;
  RETURN jsonb_build_object('raiz', v_raiz, 'motivo', null);
END;
$$;

-- Versão da composição do grupo: md5 dos pares ordenados.
CREATE OR REPLACE FUNCTION public.credito_grupo_assinatura(p_raiz uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT md5(COALESCE(string_agg(x.company || ':' || x.omie_codigo_cliente::text, ','
                                 ORDER BY x.company, x.omie_codigo_cliente), ''))
    FROM (SELECT DISTINCT g.company, g.omie_codigo_cliente
            FROM public.credito_grupo_pares(p_raiz) g) x;
$$;

-- ── 4. Proposta de limite (service_role — edge do PR 4) ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credito_propor_limite(
  p_grupo_user_id uuid,
  p_limite_brl numeric,
  p_prazo_max_dias integer,
  p_risco text,
  p_confianca numeric,
  p_ficha jsonb,
  p_saida_ia jsonb,
  p_travas jsonb,
  p_modelo text,
  p_versao_politica text,
  p_ficha_calculada_em timestamptz,
  p_grupo_assinatura text,        -- capturada com a ficha, ANTES da chamada à IA (P1-8 Codex)
  p_limite_versao_base integer    -- idem (NULL = não havia limite vigente)
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_n_pares integer;
BEGIN
  IF p_grupo_user_id IS NULL OR p_ficha IS NULL OR p_ficha_calculada_em IS NULL THEN
    RAISE EXCEPTION 'credito_propor_limite: grupo, ficha e ficha_calculada_em são obrigatórios' USING ERRCODE = '22023';
  END IF;
  IF p_ficha_calculada_em > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'credito_propor_limite: ficha_calculada_em no futuro' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customer_canonical_alias a
              WHERE a.alias_user_id = p_grupo_user_id AND a.status = 'active') THEN
    RAISE EXCEPTION 'credito_propor_limite: o grupo é a RAIZ canônica, não um alias' USING ERRCODE = '22023';
  END IF;
  IF p_grupo_assinatura IS NULL THEN
    RAISE EXCEPTION 'credito_propor_limite: assinatura do grupo lida com a ficha é obrigatória' USING ERRCODE = '22023';
  END IF;
  IF p_limite_versao_base > COALESCE((SELECT l.versao FROM public.credito_limite l
                                       WHERE l.grupo_user_id = p_grupo_user_id), 0) THEN
    RAISE EXCEPTION 'credito_propor_limite: versão-base do futuro' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_n_pares FROM public.credito_grupo_pares(p_grupo_user_id);
  IF v_n_pares = 0 THEN
    RAISE EXCEPTION 'credito_propor_limite: grupo sem par Omie comprovado' USING ERRCODE = '22023';
  END IF;

  PERFORM public.credito_portao(v_id::text);
  INSERT INTO public.credito_limite_proposta (
    id, grupo_user_id, grupo_assinatura, limite_versao_base, limite_sugerido_brl, prazo_max_dias,
    risco, confianca, ficha, saida_ia, travas, modelo, versao_politica, ficha_calculada_em)
  VALUES (
    v_id, p_grupo_user_id, p_grupo_assinatura, p_limite_versao_base,
    p_limite_brl, p_prazo_max_dias, p_risco, p_confianca, p_ficha, p_saida_ia, p_travas,
    p_modelo, p_versao_politica, p_ficha_calculada_em);
  PERFORM public.credito_portao(NULL);
  RETURN v_id;
END;
$$;

-- ── 5. Decisão humana (só o aprovador de crédito) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credito_sou_aprovador()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(private.cap_credito_escrever((SELECT auth.uid()))
                  AND EXISTS (SELECT 1 FROM public.credito_aprovador a WHERE a.user_id = (SELECT auth.uid())),
                  false);
$$;

CREATE OR REPLACE FUNCTION public.credito_aprovar_proposta(p_proposta_id uuid, p_motivo text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p public.credito_limite_proposta%ROWTYPE;
  v_versao_atual integer;
  v_nova integer;
BEGIN
  IF NOT (COALESCE(private.cap_credito_escrever(v_uid), false)
          AND EXISTS (SELECT 1 FROM public.credito_aprovador a WHERE a.user_id = v_uid)) THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: só o aprovador de crédito decide' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_p FROM public.credito_limite_proposta WHERE id = p_proposta_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: proposta inexistente' USING ERRCODE = 'P0002';
  END IF;
  -- mesma fila da reserva: aprovação e gate do grupo não se cruzam
  PERFORM pg_advisory_xact_lock(hashtextextended('credito_grupo:' || v_p.grupo_user_id::text, 0));
  SELECT * INTO v_p FROM public.credito_limite_proposta WHERE id = p_proposta_id FOR UPDATE;
  IF v_p.status <> 'pendente' THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: proposta_nao_pendente (%)', v_p.status USING ERRCODE = 'P0001';
  END IF;
  SELECT l.versao INTO v_versao_atual FROM public.credito_limite l
   WHERE l.grupo_user_id = v_p.grupo_user_id FOR UPDATE;
  IF v_versao_atual IS DISTINCT FROM v_p.limite_versao_base THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: proposta_desatualizada (base %, vigente %)',
      v_p.limite_versao_base, v_versao_atual USING ERRCODE = 'P0001';
  END IF;
  IF public.credito_grupo_assinatura(v_p.grupo_user_id) IS DISTINCT FROM v_p.grupo_assinatura THEN
    RAISE EXCEPTION 'credito_aprovar_proposta: grupo_mudou desde a proposta' USING ERRCODE = 'P0001';
  END IF;

  v_nova := COALESCE(v_versao_atual, 0) + 1;
  PERFORM public.credito_portao(v_p.grupo_user_id::text);
  INSERT INTO public.credito_limite AS l (
    grupo_user_id, limite_brl, prazo_max_dias, risco, versao, grupo_assinatura,
    ficha_calculada_em, origem_proposta_id, aprovado_por, vigente_desde)
  VALUES (v_p.grupo_user_id, v_p.limite_sugerido_brl, v_p.prazo_max_dias, v_p.risco, v_nova,
          v_p.grupo_assinatura, v_p.ficha_calculada_em, v_p.id, v_uid, now())
  ON CONFLICT (grupo_user_id) DO UPDATE SET
    limite_brl = EXCLUDED.limite_brl, prazo_max_dias = EXCLUDED.prazo_max_dias,
    risco = EXCLUDED.risco, versao = EXCLUDED.versao, grupo_assinatura = EXCLUDED.grupo_assinatura,
    ficha_calculada_em = EXCLUDED.ficha_calculada_em, origem_proposta_id = EXCLUDED.origem_proposta_id,
    aprovado_por = EXCLUDED.aprovado_por, vigente_desde = EXCLUDED.vigente_desde;

  PERFORM public.credito_portao(v_p.id::text);
  UPDATE public.credito_limite_proposta
     SET status = 'aprovada', decidido_por = v_uid, decidido_em = now(), motivo_decisao = p_motivo
   WHERE id = v_p.id AND status = 'pendente';
  PERFORM public.credito_portao(NULL);
  RETURN jsonb_build_object('grupo_user_id', v_p.grupo_user_id, 'versao', v_nova,
                            'limite_brl', v_p.limite_sugerido_brl, 'prazo_max_dias', v_p.prazo_max_dias);
END;
$$;

CREATE OR REPLACE FUNCTION public.credito_recusar_proposta(p_proposta_id uuid, p_motivo text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT (COALESCE(private.cap_credito_escrever(v_uid), false)
          AND EXISTS (SELECT 1 FROM public.credito_aprovador a WHERE a.user_id = v_uid)) THEN
    RAISE EXCEPTION 'credito_recusar_proposta: só o aprovador de crédito decide' USING ERRCODE = '42501';
  END IF;
  IF p_motivo IS NULL OR length(btrim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'credito_recusar_proposta: motivo obrigatório' USING ERRCODE = '22023';
  END IF;
  PERFORM public.credito_portao(p_proposta_id::text);
  UPDATE public.credito_limite_proposta
     SET status = 'recusada', decidido_por = v_uid, decidido_em = now(), motivo_decisao = p_motivo
   WHERE id = p_proposta_id AND status = 'pendente';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credito_recusar_proposta: proposta inexistente ou não pendente' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public.credito_portao(NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.credito_autorizar_solicitacao(
  p_solicitacao_id uuid,
  p_autorizar boolean,
  p_motivo text,
  p_validade_horas integer DEFAULT 24
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_s public.credito_solicitacao%ROWTYPE;
  v_id uuid := gen_random_uuid();
BEGIN
  IF NOT (COALESCE(private.cap_credito_escrever(v_uid), false)
          AND EXISTS (SELECT 1 FROM public.credito_aprovador a WHERE a.user_id = v_uid)) THEN
    RAISE EXCEPTION 'credito_autorizar_solicitacao: só o aprovador de crédito decide' USING ERRCODE = '42501';
  END IF;
  IF p_autorizar IS NULL OR p_motivo IS NULL OR length(btrim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'credito_autorizar_solicitacao: decisão e motivo obrigatórios' USING ERRCODE = '22023';
  END IF;
  IF p_validade_horas IS NULL OR p_validade_horas NOT BETWEEN 1 AND 72 THEN
    RAISE EXCEPTION 'credito_autorizar_solicitacao: validade entre 1 e 72 h' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_s FROM public.credito_solicitacao WHERE id = p_solicitacao_id FOR UPDATE;
  IF NOT FOUND OR v_s.status <> 'aberta' THEN
    RAISE EXCEPTION 'credito_autorizar_solicitacao: solicitação inexistente ou já decidida' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.credito_portao(v_id::text);
  INSERT INTO public.credito_autorizacao (id, solicitacao_id, autorizada, revisao, valor_max_brl,
                                          prazo_max_dias, motivo, autorizado_por, valido_ate)
  VALUES (v_id, v_s.id, p_autorizar, v_s.revisao, v_s.valor_brl, v_s.prazo_dias, p_motivo, v_uid,
          now() + make_interval(hours => p_validade_horas));
  PERFORM public.credito_portao(v_s.id::text);
  UPDATE public.credito_solicitacao
     SET status = CASE WHEN p_autorizar THEN 'autorizada' ELSE 'recusada' END, decidida_em = now()
   WHERE id = v_s.id AND status = 'aberta';
  PERFORM public.credito_portao(NULL);
  RETURN v_id;
END;
$$;

-- ── 6. Núcleo do gate: avalia, reserva e registra ──────────────────────────────────────────
-- Em `private` e SEM grant a ninguém (nem service_role): os valores entram escalares, e o que é
-- avaliado tem de ser o que é enviado. O PR 3 cria a revisão imutável (com ORDEM entre revisões)
-- e o PR 5 expõe a RPC service_role que lê pedido/par/total/parcela DA REVISÃO e chama este núcleo.
-- Condição de ativação herdada (Codex diff P1-3): o escritor de omie_customer_account_map tem de
-- tomar o mesmo advisory lock das raízes afetadas — sem isso, trocar a titularidade de um par com
-- uma reserva ainda não commitada permite 2 reservas. Até o PR 5 nada chama este núcleo.
CREATE OR REPLACE FUNCTION private.credito_avaliar_reservar(
  p_sales_order_id uuid,
  p_company text,
  p_codigo bigint,
  p_revisao text,
  p_valor numeric,
  p_prazo_dias integer,
  p_modo text,
  p_solicitante uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_corte date := ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 60);
  v_piso jsonb;
  v_raiz jsonb;
  v_root uuid;
  v_assin text;
  v_lim public.credito_limite%ROWTYPE;
  v_tem_lim boolean := false;
  v_res public.credito_reserva%ROWTYPE;
  v_tem_res boolean := false;
  v_dec_res public.credito_decisao_pedido%ROWTYPE;
  v_lastro_limite boolean := false;  -- a reserva ativa veio do limite VIGENTE deste grupo
  v_lastro_aut boolean := false;     -- … ou de autorização ainda válida DESTA revisão
  v_reusa boolean := false;
  v_base numeric := 0;               -- quanto da reserva ativa já está aprovado pelo limite
  v_aut_id uuid;
  v_titulos numeric;
  v_indet integer;
  v_piso_indet integer;
  v_venc60 integer;
  v_venc60_fora_piso integer;
  v_reservas numeric;
  v_faixa text;
  v_motivo text;
  v_dec_id uuid := gen_random_uuid();
  v_res_id uuid;
  v_sol_id uuid;
BEGIN
  IF p_sales_order_id IS NULL OR p_company IS NULL OR p_revisao IS NULL OR btrim(p_revisao) = '' THEN
    RAISE EXCEPTION 'credito_avaliar_reservar: pedido, empresa e revisão são obrigatórios' USING ERRCODE = '22023';
  END IF;
  IF p_company NOT IN ('oben','colacor','colacor_sc') THEN
    RAISE EXCEPTION 'credito_avaliar_reservar: empresa inválida %', p_company USING ERRCODE = '22023';
  END IF;
  IF p_modo IS NULL OR p_modo NOT IN ('sombra','efetivo') THEN
    RAISE EXCEPTION 'credito_avaliar_reservar: modo sombra|efetivo obrigatório' USING ERRCODE = '22023';
  END IF;
  -- NaN/Infinity ordenam acima de tudo em numeric: o teto barra os dois (Codex diff P1-7)
  IF p_valor IS NULL OR p_valor <= 0 OR p_valor >= 1e12 THEN
    RAISE EXCEPTION 'credito_avaliar_reservar: valor do pedido ausente, não positivo ou não finito' USING ERRCODE = '22023';
  END IF;
  -- O lock só serializa se cada comando vê o commit do anterior (snapshot por comando).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'credito_avaliar_reservar: exige READ COMMITTED (veio %)',
      current_setting('transaction_isolation') USING ERRCODE = '25000';
  END IF;

  -- 1) raiz → lock da fila do grupo → TUDO o mais é lido depois do lock (Codex diff P1-2)
  v_raiz := public.credito_grupo_raiz(p_company, p_codigo);
  v_root := (v_raiz ->> 'raiz')::uuid;
  IF v_root IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('credito_grupo:' || v_root::text, 0));
    -- a composição pode ter mudado enquanto esperávamos: relê a raiz SOB o lock
    IF (public.credito_grupo_raiz(p_company, p_codigo) ->> 'raiz')::uuid IS DISTINCT FROM v_root THEN
      v_faixa := 'amarelo'; v_motivo := 'grupo_mudou';
    END IF;
    v_assin := public.credito_grupo_assinatura(v_root);
  END IF;

  -- piso do PR 1 (falha propaga: o chamador segura — fail-closed)
  v_piso := public.venda_gate_credito_grupo(p_sales_order_id, p_company, p_codigo);

  -- títulos abertos do par do pedido ∪ pares do grupo, deduplicados — mesmo SEM raiz.
  -- Vocabulário = OPEN_TITLE_STATUSES + 'PAGTO PARCIAL' (existe em prod e está aberto; o saldo
  -- dele é o valor cheio porque valor_recebido não é preenchido → superestima = lado seguro).
  WITH escopo AS (
    SELECT p_company AS company, p_codigo AS codigo
    UNION
    SELECT g.company, g.omie_codigo_cliente FROM public.credito_grupo_pares(v_root) g WHERE v_root IS NOT NULL
  )
  SELECT COALESCE(sum(f.saldo) FILTER (WHERE f.saldo > 0), 0),
         count(*) FILTER (WHERE f.saldo IS NULL),
         -- dívida possivelmente > 60 d que ninguém consegue medir (ausente ≠ zero)
         count(*) FILTER (WHERE (f.saldo IS NULL OR f.data_vencimento IS NULL)
                            AND (f.data_vencimento IS NULL OR f.data_vencimento < v_corte)),
         count(*) FILTER (WHERE f.saldo > 0 AND f.data_vencimento < v_corte),
         -- vencido > 60 d comprovado num status que o piso do PR 1 não lê
         count(*) FILTER (WHERE f.saldo > 0 AND f.data_vencimento < v_corte
                            AND f.status_titulo NOT IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL'))
    INTO v_titulos, v_indet, v_piso_indet, v_venc60, v_venc60_fora_piso
    FROM escopo e
    JOIN public.fin_contas_receber f ON f.company = e.company AND f.omie_codigo_cliente = e.codigo
   WHERE e.codigo IS NOT NULL
     AND f.status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL','PAGTO PARCIAL');

  IF (v_piso ->> 'bloqueado')::boolean
     OR v_venc60_fora_piso > 0                                       -- a exceção do piso não viu isto
     OR (v_venc60 > 0 AND v_piso ->> 'motivo' <> 'excecao_valida')  -- piso lido antes de o título chegar
  THEN
    v_faixa := 'vermelho'; v_motivo := 'piso_vencido_60d';
  ELSIF v_piso_indet > 0 THEN
    -- antes de QUALQUER liberação: nem reserva antiga nem autorização pulam isto
    v_faixa := 'amarelo'; v_motivo := 'piso_indeterminado';
  ELSIF v_root IS NULL THEN
    v_faixa := 'amarelo'; v_motivo := v_raiz ->> 'motivo';
  ELSIF v_motivo IS NOT NULL THEN
    NULL;  -- grupo_mudou sob o lock
  ELSE
    -- reservas ativas de OUTROS pedidos no MESMO modo: pelo PAR atual do grupo OU pela raiz que as
    -- gravou (troca de código Omie não pode sumir com a reserva — Codex diff P1-4)
    WITH escopo AS (
      SELECT p_company AS company, p_codigo AS codigo
      UNION
      SELECT g.company, g.omie_codigo_cliente FROM public.credito_grupo_pares(v_root) g
    )
    SELECT COALESCE(sum(r.valor_brl), 0) INTO v_reservas
      FROM public.credito_reserva r
     WHERE r.status = 'ativa' AND r.modo = p_modo
       AND (r.grupo_user_id = v_root
            OR EXISTS (SELECT 1 FROM escopo e WHERE e.company = r.company AND e.codigo = r.omie_codigo_cliente))
       AND NOT (r.sales_order_id = p_sales_order_id AND r.company = p_company);

    SELECT * INTO v_res FROM public.credito_reserva r
     WHERE r.sales_order_id = p_sales_order_id AND r.company = p_company
       AND r.modo = p_modo AND r.status = 'ativa';
    v_tem_res := FOUND;
    SELECT * INTO v_lim FROM public.credito_limite l WHERE l.grupo_user_id = v_root;
    v_tem_lim := FOUND;

    -- revisão já encerrada/superada não volta a reservar — salvo se ELA é a ativa (Codex diff P1-6)
    IF NOT (v_tem_res AND v_res.revisao = p_revisao)
       AND EXISTS (SELECT 1 FROM public.credito_reserva r
                    WHERE r.sales_order_id = p_sales_order_id AND r.company = p_company
                      AND r.modo = p_modo AND r.revisao = p_revisao AND r.status <> 'ativa') THEN
      RAISE EXCEPTION 'credito_avaliar_reservar: revisao_encerrada (% já foi substituída ou encerrada)', p_revisao
        USING ERRCODE = 'P0001';
    END IF;

    -- lastro da reserva ativa (Codex diff P1-5): do limite só se for o VIGENTE e do mesmo grupo;
    -- de autorização só para a MESMA revisão e enquanto vale. Só o lastro de limite vira "base".
    IF v_tem_res THEN
      SELECT * INTO v_dec_res FROM public.credito_decisao_pedido d WHERE d.id = v_res.decisao_id;
      v_lastro_limite := v_dec_res.motivo = 'dentro_limite' AND v_tem_lim
                         AND v_dec_res.limite_versao = v_lim.versao AND v_dec_res.grupo_user_id = v_root;
      v_lastro_aut := v_dec_res.motivo = 'autorizado' AND v_res.revisao = p_revisao
                      AND EXISTS (SELECT 1 FROM public.credito_autorizacao a
                                   WHERE a.id = v_dec_res.autorizacao_id AND a.valido_ate > now());
      v_reusa := v_res.revisao = p_revisao AND (v_lastro_limite OR v_lastro_aut);
      v_base := CASE WHEN v_lastro_limite THEN v_res.valor_brl ELSE 0 END;
    END IF;

    SELECT a.id INTO v_aut_id
      FROM public.credito_autorizacao a
      JOIN public.credito_solicitacao s ON s.id = a.solicitacao_id
     WHERE s.sales_order_id = p_sales_order_id AND s.company = p_company
       AND a.revisao = p_revisao AND a.autorizada AND a.valido_ate > now()
       AND p_valor <= a.valor_max_brl
       AND ((a.prazo_max_dias IS NULL AND p_prazo_dias IS NULL) OR p_prazo_dias <= a.prazo_max_dias)
     ORDER BY a.created_at DESC
     LIMIT 1;

    IF v_reusa THEN
      v_faixa := 'verde'; v_motivo := 'reserva_existente'; v_res_id := v_res.id;
    ELSIF v_aut_id IS NOT NULL THEN
      v_faixa := 'verde'; v_motivo := 'autorizado';
    ELSIF NOT v_tem_lim THEN
      v_faixa := 'amarelo'; v_motivo := 'sem_limite';
    ELSIF v_lim.grupo_assinatura IS DISTINCT FROM v_assin THEN
      v_faixa := 'amarelo'; v_motivo := 'grupo_mudou';
    ELSIF v_lim.ficha_calculada_em < now() - interval '14 days' THEN
      v_faixa := 'amarelo'; v_motivo := 'limite_desatualizado';
    ELSIF v_lim.risco IN ('alto','sem_evidencia') THEN
      v_faixa := 'amarelo'; v_motivo := 'risco_' || v_lim.risco;
    ELSIF p_prazo_dias IS NULL THEN
      v_faixa := 'amarelo'; v_motivo := 'prazo_ilegivel';
    ELSIF p_prazo_dias > v_lim.prazo_max_dias THEN
      v_faixa := 'amarelo'; v_motivo := 'prazo_acima';
    ELSIF v_indet > 0 THEN
      v_faixa := 'amarelo'; v_motivo := 'exposicao_indeterminada';
    ELSIF p_valor > v_base AND v_titulos + v_reservas + p_valor > v_lim.limite_brl THEN
      -- só o ACRÉSCIMO sobre o que o limite vigente já cobria é cobrado
      v_faixa := 'amarelo'; v_motivo := 'estoura_limite';
    ELSE
      v_faixa := 'verde'; v_motivo := 'dentro_limite';
    END IF;
  END IF;

  -- 3) decisão (append-only) — antes da reserva/solicitação, que a referenciam
  PERFORM public.credito_portao(v_dec_id::text);
  INSERT INTO public.credito_decisao_pedido (
    id, sales_order_id, company, omie_codigo_cliente, modo, grupo_user_id, grupo_assinatura, revisao,
    valor_brl, prazo_dias, faixa, motivo, exposicao_titulos_brl, exposicao_reservas_brl,
    reserva_anterior_brl, limite_brl, prazo_max_dias, limite_versao, autorizacao_id, piso, solicitante)
  VALUES (
    v_dec_id, p_sales_order_id, p_company, p_codigo, p_modo, v_root, v_assin, p_revisao,
    p_valor, p_prazo_dias, v_faixa, v_motivo, v_titulos, v_reservas,
    CASE WHEN v_tem_res THEN v_res.valor_brl END,
    CASE WHEN v_tem_lim THEN v_lim.limite_brl END, CASE WHEN v_tem_lim THEN v_lim.prazo_max_dias END,
    CASE WHEN v_tem_lim THEN v_lim.versao END,
    CASE WHEN v_motivo = 'autorizado' THEN v_aut_id END, v_piso, p_solicitante);

  -- 4) reserva no 🟢 (a anterior vira 'substituida'; a nova cobre o MAIOR dos dois — redução só
  --    solta depois que o Omie confirmar, PR 5/6)
  IF v_faixa = 'verde' AND v_motivo <> 'reserva_existente' THEN
    IF v_tem_res THEN
      PERFORM public.credito_portao(v_res.id::text);
      UPDATE public.credito_reserva
         SET status = 'substituida', encerrada_em = now(), motivo_encerramento = 'reavaliada na revisão ' || p_revisao
       WHERE id = v_res.id AND status = 'ativa';
    END IF;
    v_res_id := gen_random_uuid();
    PERFORM public.credito_portao(v_res_id::text);
    INSERT INTO public.credito_reserva (id, decisao_id, sales_order_id, company, omie_codigo_cliente,
                                        modo, grupo_user_id, revisao, valor_brl)
    VALUES (v_res_id, v_dec_id, p_sales_order_id, p_company, p_codigo, p_modo, v_root, p_revisao,
            greatest(p_valor, CASE WHEN v_tem_res THEN v_res.valor_brl ELSE 0 END));
  END IF;

  -- 5) 🟡 efetivo resolvível pelo aprovador → solicitação (1 aberta por pedido+empresa+revisão).
  --    Pendência cadastral não vai à fila: aprovar não a resolveria.
  IF v_faixa = 'amarelo' AND p_modo = 'efetivo'
     AND v_motivo NOT IN ('sem_grupo','grupo_conflito','piso_indeterminado','grupo_mudou') THEN
    SELECT s.id INTO v_sol_id FROM public.credito_solicitacao s
     WHERE s.sales_order_id = p_sales_order_id AND s.company = p_company
       AND s.revisao = p_revisao AND s.status = 'aberta';
    IF v_sol_id IS NULL THEN
      v_sol_id := gen_random_uuid();
      PERFORM public.credito_portao(v_sol_id::text);
      INSERT INTO public.credito_solicitacao (id, decisao_id, sales_order_id, company, revisao,
                                              valor_brl, prazo_dias, motivo)
      VALUES (v_sol_id, v_dec_id, p_sales_order_id, p_company, p_revisao, p_valor, p_prazo_dias, v_motivo);
    END IF;
  END IF;
  PERFORM public.credito_portao(NULL);

  RETURN jsonb_build_object(
    'faixa', v_faixa, 'motivo', v_motivo, 'decisao_id', v_dec_id, 'reserva_id', v_res_id,
    'solicitacao_id', v_sol_id, 'grupo_user_id', v_root, 'modo', p_modo,
    'pendencia_cadastral', v_motivo IN ('sem_grupo','grupo_conflito','piso_indeterminado','grupo_mudou'),
    'exposicao_titulos_brl', v_titulos, 'exposicao_reservas_brl', v_reservas,
    'limite_brl', CASE WHEN v_tem_lim THEN v_lim.limite_brl END,
    'prazo_max_dias', CASE WHEN v_tem_lim THEN v_lim.prazo_max_dias END,
    'piso', v_piso);
END;
$$;

-- ── 7. ACL das funções ─────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.credito_grupo_raiz(text, bigint) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credito_grupo_assinatura(uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credito_propor_limite(uuid, numeric, integer, text, numeric, jsonb, jsonb, jsonb, text, text, timestamptz, text, integer) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.credito_grupo_raiz(text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.credito_grupo_assinatura(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.credito_propor_limite(uuid, numeric, integer, text, numeric, jsonb, jsonb, jsonb, text, text, timestamptz, text, integer) TO service_role;

-- núcleo do gate: ninguém executa direto (só o owner/RPC do PR 5)
REVOKE ALL ON FUNCTION private.credito_avaliar_reservar(uuid, text, bigint, text, numeric, integer, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.credito_sou_aprovador() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.credito_aprovar_proposta(uuid, text) FROM anon, PUBLIC, service_role;
REVOKE EXECUTE ON FUNCTION public.credito_recusar_proposta(uuid, text) FROM anon, PUBLIC, service_role;
REVOKE EXECUTE ON FUNCTION public.credito_autorizar_solicitacao(uuid, boolean, text, integer) FROM anon, PUBLIC, service_role;
GRANT EXECUTE ON FUNCTION public.credito_sou_aprovador() TO authenticated;
GRANT EXECUTE ON FUNCTION public.credito_aprovar_proposta(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.credito_recusar_proposta(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.credito_autorizar_solicitacao(uuid, boolean, text, integer) TO authenticated;

-- Allowlist de EXECUTE: sai todo grantee direto que não é o dono nem o papel previsto
-- (o default ACL dá EXECUTE a sandbox_exec_<ref> em função nova — P0 Codex diff).
DO $acl$
DECLARE
  f record;
  g record;
BEGIN
  FOR f IN SELECT p.oid, p.oid::regprocedure::text AS sig, p.proowner,
                  CASE WHEN p.proname IN ('credito_sou_aprovador','credito_aprovar_proposta',
                                          'credito_recusar_proposta','credito_autorizar_solicitacao') THEN 'authenticated'
                       WHEN p.proname IN ('credito_grupo_raiz','credito_grupo_assinatura','credito_propor_limite') THEN 'service_role'
                  END AS pode
             FROM pg_proc p
            WHERE (p.pronamespace = 'public'::regnamespace
                   AND p.proname IN ('credito_guarda_escrita','credito_portao','credito_grupo_raiz','credito_grupo_assinatura',
                                     'credito_propor_limite','credito_sou_aprovador','credito_aprovar_proposta',
                                     'credito_recusar_proposta','credito_autorizar_solicitacao'))
               OR (p.pronamespace = 'private'::regnamespace AND p.proname = 'credito_avaliar_reservar') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    FOR g IN SELECT DISTINCT a.grantee::regrole::text AS papel
               FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
              WHERE p.oid = f.oid AND a.grantee <> 0 AND a.grantee <> f.proowner LOOP
      IF g.papel IS DISTINCT FROM f.pode THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', f.sig, g.papel);
      END IF;
    END LOOP;
  END LOOP;
END
$acl$;

-- ── 8. Postcondição (envelope, docs/agent/database.md §Escrita) ────────────────────────────
DO $post$
DECLARE
  t text;
  f text;
  r text;
  v_n integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['credito_aprovador','credito_limite_proposta','credito_limite',
                           'credito_decisao_pedido','credito_reserva','credito_solicitacao',
                           'credito_autorizacao'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE EXCEPTION 'POS FALHOU: tabela % não existe', t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'POS FALHOU: % sem RLS', t;
    END IF;
    SELECT count(*) INTO v_n FROM pg_trigger
     WHERE tgrelid = ('public.' || t)::regclass AND NOT tgisinternal
       AND tgname IN ('credito_guarda_linha','credito_guarda_truncate') AND tgenabled = 'O';
    IF v_n <> 2 THEN
      RAISE EXCEPTION 'POS FALHOU: % sem as 2 guardas de escrita ativas (veio %)', t, v_n;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_table_privilege(r, 'public.' || t, 'INSERT') OR has_table_privilege(r, 'public.' || t, 'UPDATE')
         OR has_table_privilege(r, 'public.' || t, 'DELETE') OR has_table_privilege(r, 'public.' || t, 'TRUNCATE') THEN
        RAISE EXCEPTION 'POS FALHOU: % escreve direto em %', r, t;
      END IF;
      -- grant de COLUNA também é escrita (P1-9 Codex)
      IF has_any_column_privilege(r, 'public.' || t, 'INSERT') OR has_any_column_privilege(r, 'public.' || t, 'UPDATE') THEN
        RAISE EXCEPTION 'POS FALHOU: % tem grant de coluna para escrever em %', r, t;
      END IF;
    END LOOP;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'POS FALHOU: anon lê %', t;
    END IF;
  END LOOP;
  -- nenhum grantee além do dono escreve; SELECT só authenticated/service_role/claude_ro (allowlist: sem authenticated)
  SELECT count(*) INTO v_n
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relname IN ('credito_aprovador','credito_limite_proposta','credito_limite','credito_decisao_pedido',
                       'credito_reserva','credito_solicitacao','credito_autorizacao')
     AND a.grantee <> c.relowner
     AND (a.privilege_type <> 'SELECT'
          OR a.grantee = 0
          OR a.grantee::regrole::text NOT IN ('authenticated','service_role','claude_ro')
          OR (c.relname = 'credito_aprovador' AND a.grantee::regrole::text = 'authenticated'));
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POS FALHOU: % grant(s) fora da allowlist nas tabelas de crédito', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_class c JOIN pg_attribute at ON at.attrelid = c.oid AND at.attacl IS NOT NULL
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE 'credito\_%';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POS FALHOU: grant de coluna em tabela de crédito';
  END IF;
  -- EXECUTE: nenhum grantee direto além do dono e do papel previsto, e nada para PUBLIC
  SELECT count(*) INTO v_n
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE ((p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'credito\_%'
           AND p.proname NOT IN ('credito_grupo_pares'))
          OR (p.pronamespace = 'private'::regnamespace AND p.proname = 'credito_avaliar_reservar'))
     AND a.grantee <> p.proowner
     AND (a.grantee = 0
          OR a.grantee::regrole::text IS DISTINCT FROM
             CASE WHEN p.proname IN ('credito_sou_aprovador','credito_aprovar_proposta',
                                     'credito_recusar_proposta','credito_autorizar_solicitacao') THEN 'authenticated'
                  WHEN p.proname IN ('credito_grupo_raiz','credito_grupo_assinatura','credito_propor_limite') THEN 'service_role'
             END);
  IF v_n > 0 THEN
    RAISE EXCEPTION 'POS FALHOU: % EXECUTE fora da allowlist nas funções de crédito', v_n;
  END IF;
  -- índices que sustentam "1 reserva ativa" e "1 solicitação aberta" (Codex diff P2-8)
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.credito_reserva_uma_ativa_por_pedido')
                  AND i.indisunique AND i.indisvalid
                  AND pg_get_indexdef(i.indexrelid) ~ '\(sales_order_id, company, modo\) WHERE \(status = ''ativa''')
     OR NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = to_regclass('public.credito_solicitacao_uma_aberta')
                  AND i.indisunique AND i.indisvalid
                  AND pg_get_indexdef(i.indexrelid) ~ '\(sales_order_id, company, revisao\) WHERE \(status = ''aberta''') THEN
    RAISE EXCEPTION 'POS FALHOU: índice único parcial de reserva/solicitação ausente ou diferente';
  END IF;
  IF has_table_privilege('authenticated', 'public.credito_aprovador', 'SELECT') THEN
    RAISE EXCEPTION 'POS FALHOU: authenticated lê a allowlist';
  END IF;

  FOREACH f IN ARRAY ARRAY[
      'public.credito_grupo_raiz(text,bigint)', 'public.credito_grupo_assinatura(uuid)',
      'public.credito_propor_limite(uuid,numeric,integer,text,numeric,jsonb,jsonb,jsonb,text,text,timestamptz,text,integer)'] LOOP
    IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'POS FALHOU: % não existe', f; END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'POS FALHOU: % não é SECURITY DEFINER', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % executável por anon/authenticated', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % sem EXECUTE para service_role', f;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
      'public.credito_sou_aprovador()', 'public.credito_aprovar_proposta(uuid,text)',
      'public.credito_recusar_proposta(uuid,text)',
      'public.credito_autorizar_solicitacao(uuid,boolean,text,integer)'] LOOP
    IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'POS FALHOU: % não existe', f; END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'POS FALHOU: % não é SECURITY DEFINER', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % executável por anon', f;
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % sem EXECUTE para authenticated', f;
    END IF;
  END LOOP;

  f := 'private.credito_avaliar_reservar(uuid,text,bigint,text,numeric,integer,text,uuid)';
  IF to_regprocedure(f) IS NULL OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(f)) THEN
    RAISE EXCEPTION 'POS FALHOU: núcleo do gate ausente ou não SECURITY DEFINER';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_function_privilege(r, f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % executa o núcleo do gate direto', r;
    END IF;
  END LOOP;
  IF to_regprocedure('public.credito_reserva_encerrar(uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'POS FALHOU: encerramento genérico de reserva não pode existir (P0-2 Codex)';
  END IF;

  FOREACH f IN ARRAY ARRAY['public.credito_portao(text)', 'public.credito_guarda_escrita()'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % executável por anon/authenticated', f;
    END IF;
  END LOOP;
  IF has_function_privilege('service_role', 'public.credito_portao(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: service_role abre o portão direto';
  END IF;

  -- allowlist: exatamente o Lucas, e ele com cap_credito_escrever
  IF (SELECT count(*) FROM public.credito_aprovador) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.credito_aprovador
                     WHERE user_id = '414a9727-ad1d-4998-914e-9c6ccf26cf50') THEN
    RAISE EXCEPTION 'POS FALHOU: allowlist de aprovador ≠ {Lucas}';
  END IF;
  IF NOT COALESCE(private.cap_credito_escrever('414a9727-ad1d-4998-914e-9c6ccf26cf50'), false) THEN
    RAISE EXCEPTION 'POS FALHOU: o aprovador da allowlist não tem cap_credito_escrever';
  END IF;

  -- dependências do PR 1 seguem de pé
  IF to_regprocedure('public.credito_grupo_pares(uuid)') IS NULL
     OR to_regprocedure('public.venda_gate_credito_grupo(uuid,text,bigint)') IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: funções do PR 1 ausentes';
  END IF;
END
$post$;
