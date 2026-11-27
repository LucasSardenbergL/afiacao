-- Crédito-IA PR 7, opção C, fatia 1 — espelho das OS que a Colacor SC cria DIRETO no Omie (servicos/os/ListarOS).
-- Edge: supabase/functions/omie-os-sync · prova: db/test-omie-os-sync.sh (PG17, C e pt_BR.UTF-8, com falsificação)
-- Registro: docs/historico/credito-os-omie-2026-11.md · medição: db/medir-omie-os.sql
--
-- O que nasce aqui (nada no caminho do pedido lê isto; a sombra da fatia 2 é quem consome):
--   * omie_os_espelho  — 1 linha por OS (company, n_cod_os). Só a GERAÇÃO de um run ÍNTEGRO chega aqui (Codex
--     desenho P1-2: o lote nunca lê uma mistura de duas varreduras). Campo ilegível = NULL (ausente ≠ zero).
--   * omie_os_staging  — a página gravada pelo run em curso; promovida no fechar ÍNTEGRO, descartada no resto.
--   * omie_os_sync_runs — ledger de cada varredura (íntegra ou não, e por quê).
--   * RPCs SECURITY DEFINER abrir/gravar/fechar, só service_role, todas sob o MESMO lock por empresa. O sumiço só
--     com DUAS varreduras íntegras; a 1ª data de ausência é preservada; reaparecer zera; nunca DELETE no espelho.
--   * view omie_os_abertas_v (security_invoker): faturada IS FALSE AND cancelada IS FALSE (NULL não é "aberta").
--   * cron horário :53 com {"action":"sync"} (sem corpo cairia no probe), x-cron-secret do Vault, timeout explícito.
-- Sem BEGIN/COMMIT: a transação é do `bun run db:aplicar`.

-- ── 0. pré-condições ───────────────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regprocedure('public.pode_ver_carteira_completa(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE omie-os: public.pode_ver_carteira_completa(uuid) não existe';
  END IF;
  IF to_regclass('cron.job') IS NULL OR to_regnamespace('net') IS NULL OR to_regnamespace('vault') IS NULL THEN
    RAISE EXCEPTION 'PRE omie-os: cron/net/vault ausentes';
  END IF;
END
$pre$;

-- ── 1. Tabelas ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.omie_os_sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company text NOT NULL CHECK (company = 'colacor_sc'),
  status text NOT NULL DEFAULT 'rodando' CHECK (status IN ('rodando','ok','erro')),
  integra boolean NOT NULL DEFAULT false,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  terminado_em timestamptz,
  paginas integer,
  lidas integer,
  distintas integer,
  gravadas integer,                 -- linhas no staging na hora do fechar (o banco confere, não a edge)
  total_registros_declarado integer,
  total_paginas_declarado integer,
  shape_err integer,
  promovidas integer,
  ausencias_marcadas integer,
  ausentes_confirmadas integer,
  motivo_nao_integra text,
  erro text,
  resumo jsonb,
  CHECK ((status = 'rodando') = (terminado_em IS NULL)),
  CHECK (NOT integra OR status = 'ok')
);
CREATE UNIQUE INDEX IF NOT EXISTS omie_os_sync_runs_um_rodando ON public.omie_os_sync_runs (company) WHERE status = 'rodando';
CREATE INDEX IF NOT EXISTS omie_os_sync_runs_integra_idx ON public.omie_os_sync_runs (company, terminado_em DESC) WHERE integra;

CREATE TABLE IF NOT EXISTS public.omie_os_staging (
  run_id bigint NOT NULL REFERENCES public.omie_os_sync_runs(id),
  n_cod_os bigint NOT NULL CHECK (n_cod_os > 0),
  linha jsonb NOT NULL,
  PRIMARY KEY (run_id, n_cod_os)
);

CREATE TABLE IF NOT EXISTS public.omie_os_espelho (
  company text NOT NULL CHECK (company = 'colacor_sc'),
  n_cod_os bigint NOT NULL CHECK (n_cod_os > 0),
  c_num_os text,
  c_cod_int_os text,
  n_cod_cli bigint CHECK (n_cod_cli > 0),            -- NULL = cliente ilegível no Omie
  etapa text,
  valor_total numeric CHECK (valor_total >= 0 AND valor_total < 1e12),   -- NULL = ilegível (nunca 0 fabricado)
  valor_bruto text,
  parcelas jsonb,
  n_parcelas integer CHECK (n_parcelas >= 0),
  prazo_max_dias integer CHECK (prazo_max_dias >= 0),  -- NULL = alguma parcela sem nDias, ou sem parcelas
  faturada boolean,                                    -- NULL = flag ausente/desconhecida
  cancelada boolean,
  data_inclusao timestamptz,
  data_alteracao timestamptz,
  data_faturamento timestamptz,
  payload jsonb NOT NULL,
  geracao_run bigint NOT NULL REFERENCES public.omie_os_sync_runs(id),   -- último run ÍNTEGRO que a viu
  primeira_vista_em timestamptz NOT NULL DEFAULT now(),
  ultima_vista_em timestamptz NOT NULL DEFAULT now(),
  primeira_ausencia_em timestamptz,                    -- início do run íntegro que NÃO a viu pela 1ª vez
  ausencias_integras integer NOT NULL DEFAULT 0 CHECK (ausencias_integras >= 0),
  ausente_desde timestamptz,                           -- confirmado com 2 íntegras = a 1ª data de ausência
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, n_cod_os),
  CHECK (ausente_desde IS NULL OR (ausencias_integras >= 2 AND ausente_desde = primeira_ausencia_em)),
  CHECK ((ausencias_integras = 0) = (primeira_ausencia_em IS NULL))
);
CREATE INDEX IF NOT EXISTS omie_os_espelho_cli_idx ON public.omie_os_espelho (company, n_cod_cli);

-- ── 2. RLS e ACL (allowlist: o default ACL do Supabase dá ALL a authenticated e INSERT a sandbox_exec_*) ──
-- Leitura por staff: só GESTOR (pode_ver_carteira_completa, a mesma regra do ledger de crédito). NÃO
-- fin_user_can_access: em prod ela devolve true para QUALQUER employee/master, e o espelho entregaria a OS real que o
-- probe recusa a um employee sem acesso financeiro à SC (Codex diff P0).
DO $rls$
DECLARE
  t text;
  r record;
BEGIN
  FOREACH t IN ARRAY ARRAY['omie_os_sync_runs','omie_os_staging','omie_os_espelho'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', t);
    FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
               FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.oid = ('public.' || t)::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
      EXECUTE format('REVOKE ALL ON public.%I FROM %s', t, r.papel);
    END LOOP;
    -- escrita só pelas RPCs (dono): ninguém mais tem INSERT/UPDATE/DELETE
    EXECUTE format('GRANT SELECT ON public.%I TO service_role', t);
    -- o staging é página de run em curso (talvez descartado): fica fora da medição (Codex diff P2-10)
    IF to_regrole('claude_ro') IS NOT NULL AND t <> 'omie_os_staging' THEN
      EXECUTE format('GRANT SELECT ON public.%I TO claude_ro', t);
    END IF;
  END LOOP;
  -- staff com acesso financeiro à SC lê o espelho e os runs; o staging fica só com o dono/service_role
  GRANT SELECT ON public.omie_os_sync_runs, public.omie_os_espelho TO authenticated;
  DROP POLICY IF EXISTS omie_os_espelho_select ON public.omie_os_espelho;
  CREATE POLICY omie_os_espelho_select ON public.omie_os_espelho FOR SELECT TO authenticated
    USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
  DROP POLICY IF EXISTS omie_os_sync_runs_select ON public.omie_os_sync_runs;
  CREATE POLICY omie_os_sync_runs_select ON public.omie_os_sync_runs FOR SELECT TO authenticated
    USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));
  -- a sequência do IDENTITY nasce com o default ACL (ALL a anon/authenticated): reposicioná-la faria o abrir colidir
  -- com ids usados e parar o espelho (Codex diff P1-6) → só o dono
  FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
             FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
            WHERE c.oid = pg_get_serial_sequence('public.omie_os_sync_runs', 'id')::regclass
              AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM %s', pg_get_serial_sequence('public.omie_os_sync_runs', 'id'), r.papel);
  END LOOP;
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC', pg_get_serial_sequence('public.omie_os_sync_runs', 'id'));
END
$rls$;

-- ── 3. Normalização do nº da OS / do numero_pedido (elo OS → título VENR) ──────────────────────
-- Só dígitos; sem zeros à esquerda; vazio ou só zeros → NULL (rejeitado: nunca casa com nada).
CREATE OR REPLACE FUNCTION public.omie_os_numero_normalizado(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE WHEN btrim(p) ~ '^[0-9]+$' THEN nullif(ltrim(btrim(p), '0'), '') END;
$$;

-- ── 4. RPCs do sync (SECURITY DEFINER, só service_role) ────────────────────────────────────
-- Lock por empresa (transação): abrir, gravar e fechar serializam entre si.
CREATE OR REPLACE FUNCTION public.omie_os_sync_abrir(p_company text)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_company IS DISTINCT FROM 'colacor_sc' THEN
    RAISE EXCEPTION 'omie_os_sync_abrir: empresa inválida %', p_company USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omie_os_sync:' || p_company, 0));
  -- run 'rodando' velho = edge morreu no meio: vira erro, NÃO íntegro, e o staging dele é descartado
  UPDATE public.omie_os_sync_runs SET status = 'erro', terminado_em = now(), integra = false,
         erro = 'abandonado: rodando há mais de 15 min'
   WHERE company = p_company AND status = 'rodando' AND iniciado_em < now() - interval '15 minutes';
  DELETE FROM public.omie_os_staging s
   USING public.omie_os_sync_runs r
   WHERE s.run_id = r.id AND r.company = p_company AND r.status <> 'rodando';
  IF EXISTS (SELECT 1 FROM public.omie_os_sync_runs WHERE company = p_company AND status = 'rodando') THEN
    RAISE EXCEPTION 'omie_os_sync_abrir: já há um run rodando para %', p_company USING ERRCODE = '55P03';
  END IF;
  INSERT INTO public.omie_os_sync_runs (company) VALUES (p_company) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.omie_os_sync_gravar(p_run bigint, p_linhas jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company text;
  v_status text;
  v_n integer;
BEGIN
  SELECT company INTO v_company FROM public.omie_os_sync_runs WHERE id = p_run;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'omie_os_sync_gravar: run % não existe', p_run USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omie_os_sync:' || v_company, 0));
  SELECT status INTO v_status FROM public.omie_os_sync_runs WHERE id = p_run;
  IF v_status IS DISTINCT FROM 'rodando' THEN
    RAISE EXCEPTION 'omie_os_sync_gravar: run % não está rodando (%)', p_run, v_status USING ERRCODE = '55000';
  END IF;
  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN
    RAISE EXCEPTION 'omie_os_sync_gravar: linhas não é array' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_linhas) l
              WHERE jsonb_typeof(l) <> 'object' OR jsonb_typeof(l -> 'n_cod_os') IS DISTINCT FROM 'number'
                 OR (l ->> 'n_cod_os')::numeric <> trunc((l ->> 'n_cod_os')::numeric)
                 OR (l ->> 'n_cod_os')::numeric <= 0
                 OR jsonb_typeof(l -> 'payload') IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'omie_os_sync_gravar: linha sem n_cod_os inteiro positivo ou sem payload' USING ERRCODE = '22023';
  END IF;
  -- n_cod_os repetido (na mesma chamada ou noutra página do run) viola a PK: paginação instável não passa calada
  INSERT INTO public.omie_os_staging (run_id, n_cod_os, linha)
  SELECT p_run, (l ->> 'n_cod_os')::bigint, l FROM jsonb_array_elements(p_linhas) l;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Lê um campo da linha só se o TIPO jsonb for o esperado; o resto é NULL (ausente ≠ zero).
CREATE OR REPLACE FUNCTION private.omie_os_campo_num(l jsonb, k text)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN jsonb_typeof(l -> k) = 'number' THEN (l ->> k)::numeric END;
$$;
CREATE OR REPLACE FUNCTION private.omie_os_campo_txt(l jsonb, k text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN jsonb_typeof(l -> k) = 'string' THEN nullif(btrim(l ->> k), '') END;
$$;
CREATE OR REPLACE FUNCTION private.omie_os_campo_bool(l jsonb, k text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN jsonb_typeof(l -> k) = 'boolean' THEN (l ->> k)::boolean END;
$$;
CREATE OR REPLACE FUNCTION private.omie_os_campo_ts(l jsonb, k text)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
BEGIN
  IF jsonb_typeof(l -> k) = 'string'
     AND l ->> k ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-03:00$' THEN
    RETURN (l ->> k)::timestamptz;
  END IF;
  RETURN NULL;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RETURN NULL;
END;
$$;

-- Fecha o run. O BANCO decide se é íntegro (não confia só na edge): erro nulo, a edge afirma íntegro, e o
-- staging tem EXATAMENTE as distintas = total declarado. Íntegro → promove a geração ao espelho e conta 1 ausência
-- para quem não apareceu (sumiço só na 2ª). Não íntegro → nada muda no espelho. Run já fechado → no-op (um
-- fechamento repetido ou atrasado nunca conta uma 2ª ausência — Codex desenho).
CREATE OR REPLACE FUNCTION public.omie_os_sync_fechar(p_run bigint, p_resumo jsonb, p_erro text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_run public.omie_os_sync_runs%ROWTYPE;
  v_gravadas integer;
  v_distintas integer;
  v_total integer;
  v_integra boolean;
  v_motivo text;
  v_prom integer := 0;
  v_aus integer := 0;
  v_conf integer := 0;
  v_lidas integer;
  v_vivas integer;
BEGIN
  SELECT * INTO v_run FROM public.omie_os_sync_runs WHERE id = p_run;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'omie_os_sync_fechar: run % não existe', p_run USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omie_os_sync:' || v_run.company, 0));
  SELECT * INTO v_run FROM public.omie_os_sync_runs WHERE id = p_run;
  IF v_run.status <> 'rodando' THEN
    RETURN jsonb_build_object('status', 'ja_fechado', 'run', p_run, 'run_status', v_run.status);
  END IF;

  SELECT count(*) INTO v_gravadas FROM public.omie_os_staging WHERE run_id = p_run;
  v_distintas := CASE WHEN jsonb_typeof(p_resumo -> 'distintas') = 'number' THEN (p_resumo ->> 'distintas')::integer END;
  v_total := CASE WHEN jsonb_typeof(p_resumo -> 'total_registros_declarado') = 'number'
                  THEN (p_resumo ->> 'total_registros_declarado')::integer END;
  v_lidas := CASE WHEN jsonb_typeof(p_resumo -> 'lidas') = 'number' THEN (p_resumo ->> 'lidas')::integer END;
  SELECT count(*) INTO v_vivas FROM public.omie_os_espelho WHERE company = v_run.company AND ausente_desde IS NULL;
  -- o banco exige o resumo INTEIRO coerente (Codex diff P1-4): lidas = distintas = total = staging, sem shape/contrato
  v_motivo := CASE
    WHEN p_erro IS NOT NULL THEN 'erro: ' || left(p_erro, 200)
    WHEN jsonb_typeof(p_resumo -> 'integra') IS DISTINCT FROM 'boolean' OR NOT (p_resumo ->> 'integra')::boolean
      THEN coalesce(p_resumo ->> 'motivo_nao_integra', 'edge não afirmou íntegra')
    WHEN v_total IS NULL THEN 'total_de_registros ausente'
    WHEN v_distintas IS DISTINCT FROM v_total THEN format('distintas %s ≠ total %s', v_distintas, v_total)
    WHEN v_gravadas <> v_total THEN format('staging %s ≠ total %s', v_gravadas, v_total)
    WHEN v_lidas IS DISTINCT FROM v_total THEN format('lidas %s ≠ total %s', v_lidas, v_total)
    WHEN jsonb_typeof(p_resumo -> 'shape_err') IS DISTINCT FROM 'number' OR (p_resumo ->> 'shape_err')::integer <> 0
      THEN 'shape_err ausente ou > 0'
    WHEN jsonb_typeof(p_resumo -> 'contrato_err') IS DISTINCT FROM 'number' OR (p_resumo ->> 'contrato_err')::integer <> 0
      THEN 'contrato_err ausente ou > 0'
    -- queda implausível (Codex diff P1-3): OS no Omie quase nunca somem; um total que cai abaixo de 90% das OS
    -- presentes é resposta anômala, não exclusão em massa — não promove nem conta ausência (a reserva fica)
    WHEN v_vivas > 0 AND v_total < 0.9 * v_vivas THEN format('queda implausível: total %s < 90%% de %s presentes', v_total, v_vivas)
  END;
  v_integra := v_motivo IS NULL;

  IF v_integra THEN
    INSERT INTO public.omie_os_espelho AS e (
      company, n_cod_os, c_num_os, c_cod_int_os, n_cod_cli, etapa, valor_total, valor_bruto, parcelas, n_parcelas,
      prazo_max_dias, faturada, cancelada, data_inclusao, data_alteracao, data_faturamento, payload, geracao_run,
      primeira_vista_em, ultima_vista_em, primeira_ausencia_em, ausencias_integras, ausente_desde, atualizado_em)
    SELECT v_run.company, s.n_cod_os,
           private.omie_os_campo_txt(s.linha, 'c_num_os'),
           private.omie_os_campo_txt(s.linha, 'c_cod_int_os'),
           CASE WHEN private.omie_os_campo_num(s.linha, 'n_cod_cli') > 0
                 AND private.omie_os_campo_num(s.linha, 'n_cod_cli') = trunc(private.omie_os_campo_num(s.linha, 'n_cod_cli'))
                THEN private.omie_os_campo_num(s.linha, 'n_cod_cli')::bigint END,
           private.omie_os_campo_txt(s.linha, 'etapa'),
           CASE WHEN private.omie_os_campo_num(s.linha, 'valor_total') >= 0
                 AND private.omie_os_campo_num(s.linha, 'valor_total') < 1e12
                THEN private.omie_os_campo_num(s.linha, 'valor_total') END,
           private.omie_os_campo_txt(s.linha, 'valor_bruto'),
           CASE WHEN jsonb_typeof(s.linha -> 'parcelas') = 'array' THEN s.linha -> 'parcelas' END,
           CASE WHEN private.omie_os_campo_num(s.linha, 'n_parcelas') >= 0
                 AND private.omie_os_campo_num(s.linha, 'n_parcelas') = trunc(private.omie_os_campo_num(s.linha, 'n_parcelas'))
                THEN private.omie_os_campo_num(s.linha, 'n_parcelas')::integer END,
           CASE WHEN private.omie_os_campo_num(s.linha, 'prazo_max_dias') >= 0
                 AND private.omie_os_campo_num(s.linha, 'prazo_max_dias') = trunc(private.omie_os_campo_num(s.linha, 'prazo_max_dias'))
                 AND private.omie_os_campo_num(s.linha, 'prazo_max_dias') < 100000
                THEN private.omie_os_campo_num(s.linha, 'prazo_max_dias')::integer END,
           private.omie_os_campo_bool(s.linha, 'faturada'),
           private.omie_os_campo_bool(s.linha, 'cancelada'),
           private.omie_os_campo_ts(s.linha, 'data_inclusao'),
           private.omie_os_campo_ts(s.linha, 'data_alteracao'),
           private.omie_os_campo_ts(s.linha, 'data_faturamento'),
           s.linha -> 'payload', p_run, now(), now(), NULL, 0, NULL, now()
      FROM public.omie_os_staging s
     WHERE s.run_id = p_run
    ON CONFLICT (company, n_cod_os) DO UPDATE SET
      c_num_os = EXCLUDED.c_num_os, c_cod_int_os = EXCLUDED.c_cod_int_os, n_cod_cli = EXCLUDED.n_cod_cli,
      etapa = EXCLUDED.etapa, valor_total = EXCLUDED.valor_total, valor_bruto = EXCLUDED.valor_bruto,
      parcelas = EXCLUDED.parcelas, n_parcelas = EXCLUDED.n_parcelas, prazo_max_dias = EXCLUDED.prazo_max_dias,
      faturada = EXCLUDED.faturada, cancelada = EXCLUDED.cancelada, data_inclusao = EXCLUDED.data_inclusao,
      data_alteracao = EXCLUDED.data_alteracao, data_faturamento = EXCLUDED.data_faturamento,
      payload = EXCLUDED.payload, geracao_run = EXCLUDED.geracao_run, ultima_vista_em = now(),
      -- reapareceu: a ausência recomeça do zero
      primeira_ausencia_em = NULL, ausencias_integras = 0, ausente_desde = NULL,
      atualizado_em = now();
    GET DIAGNOSTICS v_prom = ROW_COUNT;

    -- quem NÃO apareceu nesta varredura íntegra: +1 ausência; a 1ª data fica; na 2ª, ausente_desde = a 1ª data
    UPDATE public.omie_os_espelho e
       SET ausencias_integras = e.ausencias_integras + 1,
           primeira_ausencia_em = coalesce(e.primeira_ausencia_em, v_run.iniciado_em),
           ausente_desde = CASE WHEN e.ausencias_integras + 1 >= 2
                                THEN coalesce(e.primeira_ausencia_em, v_run.iniciado_em) END,
           atualizado_em = now()
     WHERE e.company = v_run.company AND e.geracao_run <> p_run;
    GET DIAGNOSTICS v_aus = ROW_COUNT;
    SELECT count(*) INTO v_conf FROM public.omie_os_espelho e
     WHERE e.company = v_run.company AND e.geracao_run <> p_run AND e.ausencias_integras = 2;
  END IF;

  UPDATE public.omie_os_sync_runs SET
    status = CASE WHEN p_erro IS NULL THEN 'ok' ELSE 'erro' END,
    integra = v_integra, terminado_em = now(),
    paginas = CASE WHEN jsonb_typeof(p_resumo -> 'paginas') = 'number' THEN (p_resumo ->> 'paginas')::integer END,
    lidas = CASE WHEN jsonb_typeof(p_resumo -> 'lidas') = 'number' THEN (p_resumo ->> 'lidas')::integer END,
    distintas = v_distintas, gravadas = v_gravadas,
    total_registros_declarado = v_total,
    total_paginas_declarado = CASE WHEN jsonb_typeof(p_resumo -> 'total_paginas_declarado') = 'number'
                                   THEN (p_resumo ->> 'total_paginas_declarado')::integer END,
    shape_err = CASE WHEN jsonb_typeof(p_resumo -> 'shape_err') = 'number' THEN (p_resumo ->> 'shape_err')::integer END,
    promovidas = v_prom, ausencias_marcadas = v_aus, ausentes_confirmadas = v_conf,
    motivo_nao_integra = v_motivo, erro = left(p_erro, 600), resumo = p_resumo
   WHERE id = p_run;
  DELETE FROM public.omie_os_staging WHERE run_id = p_run;
  RETURN jsonb_build_object('status', 'fechado', 'run', p_run, 'integra', v_integra, 'motivo', v_motivo,
                            'promovidas', v_prom, 'ausencias_marcadas', v_aus, 'ausentes_confirmadas', v_conf);
END;
$$;

-- ACL das funções: as 3 RPCs só service_role; os helpers de campo só o dono; o normalizador é puro e legível
DO $acl$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS fn, a.grantee::regrole::text AS papel
             FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
            WHERE p.proname IN ('omie_os_sync_abrir','omie_os_sync_gravar','omie_os_sync_fechar','omie_os_numero_normalizado',
                                'omie_os_campo_num','omie_os_campo_txt','omie_os_campo_bool','omie_os_campo_ts')
              AND p.pronamespace IN ('public'::regnamespace, 'private'::regnamespace)
              AND a.grantee <> 0 AND a.grantee <> p.proowner LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', r.fn, r.papel);
  END LOOP;
  REVOKE ALL ON FUNCTION public.omie_os_sync_abrir(text), public.omie_os_sync_gravar(bigint, jsonb),
                         public.omie_os_sync_fechar(bigint, jsonb, text), public.omie_os_numero_normalizado(text),
                         private.omie_os_campo_num(jsonb, text), private.omie_os_campo_txt(jsonb, text),
                         private.omie_os_campo_bool(jsonb, text), private.omie_os_campo_ts(jsonb, text)
    FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.omie_os_sync_abrir(text), public.omie_os_sync_gravar(bigint, jsonb),
                            public.omie_os_sync_fechar(bigint, jsonb, text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.omie_os_numero_normalizado(text) TO authenticated, service_role;
  IF to_regrole('claude_ro') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.omie_os_numero_normalizado(text) TO claude_ro;
  END IF;
END
$acl$;

-- ── 5. View das OS abertas (security_invoker: lê com a RLS de quem consulta) ───────────────────
-- Aberta = faturada IS FALSE AND cancelada IS FALSE (flag NULL não é aberta: é indeterminada) e não ausente.
-- idade_dias / dias_sem_movimento em dias corridos de Brasília; NULL quando a data falta (indeterminado).
CREATE OR REPLACE VIEW public.omie_os_abertas_v WITH (security_invoker = on) AS
SELECT e.company, e.n_cod_os, e.c_num_os, e.n_cod_cli, e.etapa, e.valor_total, e.prazo_max_dias,
       e.data_inclusao, e.data_alteracao,
       (now() AT TIME ZONE 'America/Sao_Paulo')::date - (e.data_inclusao AT TIME ZONE 'America/Sao_Paulo')::date
         AS idade_dias,
       (now() AT TIME ZONE 'America/Sao_Paulo')::date
         - (coalesce(greatest(e.data_alteracao, e.data_inclusao), e.data_inclusao) AT TIME ZONE 'America/Sao_Paulo')::date
         AS dias_sem_movimento,
       e.geracao_run, e.ultima_vista_em, e.ausencias_integras
  FROM public.omie_os_espelho e
 WHERE e.faturada IS FALSE AND e.cancelada IS FALSE AND e.ausente_desde IS NULL;

DO $vacl$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
             FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
            WHERE c.oid = 'public.omie_os_abertas_v'::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
    EXECUTE format('REVOKE ALL ON public.omie_os_abertas_v FROM %s', r.papel);
  END LOOP;
  REVOKE ALL ON public.omie_os_abertas_v FROM PUBLIC, anon;
  GRANT SELECT ON public.omie_os_abertas_v TO authenticated, service_role;
  IF to_regrole('claude_ro') IS NOT NULL THEN
    GRANT SELECT ON public.omie_os_abertas_v TO claude_ro;
  END IF;
END
$vacl$;

-- ── 6. cron horário (:53 — o :17 é do omie-pv-exclusao-reconciliar) ──────────────────────────
DO $cron$
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'omie-os-sync-1h';
  PERFORM cron.schedule('omie-os-sync-1h', '53 * * * *', $cmd$
    SELECT net.http_post(url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-os-sync',
      headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
      body:='{"action":"sync"}'::jsonb, timeout_milliseconds:=150000);
  $cmd$);
END
$cron$;

-- ── 7. pós-condição ────────────────────────────────────────────────────────────────────────
DO $pos$
BEGIN
  IF (SELECT count(*) FROM pg_class c WHERE c.oid IN ('public.omie_os_sync_runs'::regclass,
        'public.omie_os_staging'::regclass, 'public.omie_os_espelho'::regclass) AND c.relrowsecurity) <> 3 THEN
    RAISE EXCEPTION 'POSCONDICAO omie-os: RLS ausente';
  END IF;
  -- fora do dono, só SELECT (e nunca para PUBLIC/anon) nas 3 tabelas e na view
  IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
              WHERE c.oid IN ('public.omie_os_sync_runs'::regclass, 'public.omie_os_staging'::regclass,
                              'public.omie_os_espelho'::regclass, 'public.omie_os_abertas_v'::regclass)
                AND a.grantee <> c.relowner
                AND (a.grantee = 0 OR a.grantee = 'anon'::regrole OR a.privilege_type <> 'SELECT')) THEN
    RAISE EXCEPTION 'POSCONDICAO omie-os: privilégio fora do dono além de SELECT';
  END IF;
  IF has_table_privilege('authenticated', 'public.omie_os_staging', 'SELECT')
     OR (to_regrole('claude_ro') IS NOT NULL AND has_table_privilege('claude_ro', 'public.omie_os_staging', 'SELECT')) THEN
    RAISE EXCEPTION 'POSCONDICAO omie-os: staging legível fora do dono/service_role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) a
              WHERE c.oid = pg_get_serial_sequence('public.omie_os_sync_runs', 'id')::regclass
                AND a.grantee <> c.relowner) THEN
    RAISE EXCEPTION 'POSCONDICAO omie-os: sequência dos runs com privilégio fora do dono';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid IN ('public.omie_os_espelho'::regclass, 'public.omie_os_sync_runs'::regclass)
        AND pg_get_expr(polqual, polrelid) LIKE '%pode_ver_carteira_completa%') <> 2
     OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid IN ('public.omie_os_espelho'::regclass, 'public.omie_os_sync_runs'::regclass)
                  AND pg_get_expr(polqual, polrelid) LIKE '%fin_user_can_access%') THEN
    RAISE EXCEPTION 'POSCONDICAO omie-os: leitura do espelho fora da regra de gestor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.omie_os_abertas_v'::regclass
                                         AND reloptions @> ARRAY['security_invoker=on']) THEN
    RAISE EXCEPTION 'POSCONDICAO omie-os: view sem security_invoker';
  END IF;
  IF has_function_privilege('anon', 'public.omie_os_sync_fechar(bigint,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.omie_os_sync_fechar(bigint,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.omie_os_sync_gravar(bigint,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.omie_os_sync_abrir(text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.omie_os_sync_fechar(bigint,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSCONDICAO omie-os: ACL das RPCs fora do esperado';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'omie-os-sync-1h' AND active AND schedule = '53 * * * *'
        AND command LIKE '%timeout_milliseconds:=150000%' AND command LIKE '%x-cron-secret%'
        AND command LIKE '%{"action":"sync"}%') <> 1 THEN
    RAISE EXCEPTION 'POSCONDICAO omie-os: cron ausente ou fora do contrato';
  END IF;
  RAISE NOTICE 'POSCONDICAO omie-os OK';
END
$pos$;
