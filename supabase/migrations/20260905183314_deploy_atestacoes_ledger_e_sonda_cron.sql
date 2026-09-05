-- ============================================================
-- deploy_atestacoes — LEDGER de atestação de deploy de edge (+ o coletor por cron)
-- Objetivo: docs/historico/deploy-redundante-ledger-e-cron-de-sonda.md
-- ============================================================
-- POR QUÊ: a única prova de qual bundle de uma edge está em produção é a resposta da sonda
-- (`{"probe":true}` → `{versao, edge, fonte}`) ou o eco passivo (`{versao, edge, fonte}` em
-- toda resposta de cron). As duas caem em `net._http_response`, e `pg_net.ttl = 6h` as apaga.
-- Sem memória, cada sessão via 47/54 edges "sem sonda na janela" e pedia ao founder para colar
-- o SQL de sonda DE NOVO. Bundle só muda por deploy explícito ⇒ a atestação vale até o `fonte`
-- da main mudar. Este arquivo dá memória. A sonda continua HUMANA (uma por deploy, e a 1ª de
-- edge nova) — um cron de sonda ativa foi desenhado e DERRUBADO (Codex, 2026-09-05): rollback
-- para bundle pré-sensor faria o cron disparar o fluxo real (`monthly-report` = e-mail para a
-- base inteira). Ver o doc do objetivo.
--
-- 3 objetos, e a divisão de trabalho:
--   1. public.deploy_atestacoes               — o ledger, 1 linha por resposta observada.
--   2. public.deploy_atestacoes_janela_viva() — a ÚNICA definição de "observação válida" sobre
--      net._http_response. O coletor E o leitor (`bun run pendencias:deploy`) usam a mesma; duas
--      cópias do filtro divergiriam em silêncio (#2103 documentou o ponto cego do eco passivo e o
--      script ficou cego por dias porque a query dele não acompanhou a doc).
--   3. public.deploy_atestacoes_colher() + cron `deploy-atestacoes-colher` (15/15 min) — copia a
--      janela para o ledger, idempotente por (request_id, observado_em).
--
-- Limites conhecidos (não promessas): as tabelas do pg_net são UNLOGGED — resposta perdida num
-- restart não reaparece, e coletor parado por mais de 6h perde a janela. O CLI mede a saúde do
-- coletor em `cron.job_run_details` e trata parada como MECÂNICA, não como "tudo confere".
--
-- Idempotente: pode ser colada mais de uma vez. Postcondição no fim aborta o Run se algo faltar.

BEGIN;

-- ------------------------------------------------------------
-- 1. O ledger
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deploy_atestacoes (
  -- `net._http_response.id` da resposta copiada. A chave é o PAR com `observado_em`: o schema
  -- do pg_net não declara unicidade do id, e um reset não colidiria com observação antiga.
  request_id    bigint      NOT NULL,
  observado_em  timestamptz NOT NULL,
  edge          text        NOT NULL,
  versao        text        NOT NULL,
  -- `fonte` pode ser 'nao-mapeada' (bundle subiu sem o mapa — DIVERGÊNCIA, não ausência) ou
  -- 'sem-campo' (eco que não traz fingerprint — não prova o closure). Nunca NULL: ausente ≠ zero.
  fonte         text        NOT NULL,
  via           text        NOT NULL CHECK (via IN ('sonda', 'eco')),
  registrado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, observado_em)
);

CREATE INDEX IF NOT EXISTS idx_deploy_atestacoes_edge_observado
  ON public.deploy_atestacoes (edge, observado_em DESC);

COMMENT ON TABLE public.deploy_atestacoes IS
  'Ledger de atestação de deploy de edge: cada linha é uma resposta de prod que disse qual bundle '
  '(versao, fonte) está no ar. Alimentado pelo cron deploy-atestacoes-colher a partir de '
  'net._http_response (pg_net.ttl = 6h). Lido por `bun run pendencias:deploy`.';

-- RLS (obrigatória). Fechada por PRIVILÉGIO: anon nada; authenticated só SELECT, e a policy
-- restringe a staff. Só o cron (postgres, dono) escreve; service_role bypassa por atributo de
-- role. ⚠️ REVOKE FROM PUBLIC não tira anon/authenticated (grant explícito por nome).
-- `claude_ro` (psql-ro) tem BYPASSRLS medido em prod (2026-09-05) e SELECT pelo default ACL.
ALTER TABLE public.deploy_atestacoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deploy_atestacoes FROM anon;
REVOKE ALL ON public.deploy_atestacoes FROM authenticated;
GRANT SELECT ON public.deploy_atestacoes TO authenticated;

DROP POLICY IF EXISTS "deploy_atestacoes_select_staff" ON public.deploy_atestacoes;
CREATE POLICY "deploy_atestacoes_select_staff"
  ON public.deploy_atestacoes
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('employee'::public.app_role, 'master'::public.app_role)
    )
  );

DROP POLICY IF EXISTS "deploy_atestacoes_service_all" ON public.deploy_atestacoes;
CREATE POLICY "deploy_atestacoes_service_all"
  ON public.deploy_atestacoes
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ------------------------------------------------------------
-- 2. A janela viva — UMA definição de "observação válida"
-- ------------------------------------------------------------
-- Duas vias pelas quais prod diz qual bundle está no ar:
--   · SONDA ATIVA: `probe` é o BOOLEANO true (resposta de `criarRespostaSonda`).
--   · ECO PASSIVO: `edge` + `versao` presentes e `probe` AUSENTE (cron real que ecoa a versão).
-- `probe` presente com outro valor/tipo fica DE FORA: forma que não emitimos; admitir shape
-- desconhecido no instrumento de deploy é fail-OPEN. A ausência é testada com `NOT (c ? 'probe')`
-- e nunca com desigualdade: chave ausente devolve NULL, que não é TRUE, e a linha sumiria.
--
-- Forma de cada campo (achado do Codex): `{"edge":null}` passa no `?` e morreria no NOT NULL do
-- ledger, derrubando a cópia INTEIRA por 6h; slug fora do formato do repo entraria numa URL um
-- dia; `fonte` que não é SHA-256 nem sentinela é lixo. Linha que não tem a forma não é nossa —
-- fica fora sem derrubar as vizinhas.
--
-- O cast para jsonb vive num CASE: filtro textual antes do cast é ordem de PLANO, não da
-- linguagem (a trava por CASE do `deploy.md` §Sondar VÁRIAS edges, pela mesma razão).
CREATE OR REPLACE FUNCTION public.deploy_atestacoes_janela_viva()
RETURNS TABLE (
  request_id   bigint,
  observado_em timestamptz,
  edge         text,
  versao       text,
  fonte        text,
  via          text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  SELECT r.id,
         r.created,
         r.c ->> 'edge',
         r.c ->> 'versao',
         coalesce(r.c ->> 'fonte', 'sem-campo'),
         CASE WHEN (r.c -> 'probe') = to_jsonb(true) THEN 'sonda' ELSE 'eco' END
  FROM (
    SELECT id, created,
           CASE WHEN content IS JSON OBJECT THEN content::jsonb END AS c
    FROM net._http_response
    WHERE status_code = 200
      AND id IS NOT NULL
      AND created IS NOT NULL
      AND content IS NOT NULL
      AND left(ltrim(content), 1) = '{'
      AND content LIKE '%"edge"%'
      AND content LIKE '%"versao"%'
  ) r
  WHERE r.c IS NOT NULL
    AND jsonb_typeof(r.c -> 'edge') = 'string'
    AND jsonb_typeof(r.c -> 'versao') = 'string'
    AND (r.c ->> 'edge') ~ '^[a-z0-9-]{1,80}$'
    AND length(r.c ->> 'versao') BETWEEN 1 AND 120
    AND (
      NOT (r.c ? 'fonte')
      OR (jsonb_typeof(r.c -> 'fonte') = 'string'
          AND ((r.c ->> 'fonte') ~ '^[0-9a-f]{64}$' OR (r.c ->> 'fonte') = 'nao-mapeada'))
    )
    AND (NOT (r.c ? 'probe') OR (r.c -> 'probe') = to_jsonb(true))
$fn$;

COMMENT ON FUNCTION public.deploy_atestacoes_janela_viva() IS
  'Observações válidas de deploy na janela viva de net._http_response (sonda ativa OU eco passivo). '
  'Fonte única do filtro: usada pelo coletor e por `bun run pendencias:deploy`.';

-- ------------------------------------------------------------
-- 3. O coletor — copia a janela para o ledger
-- ------------------------------------------------------------
-- Varre a janela INTEIRA a cada passagem (≤ ~300 linhas) em vez de watermark por id: a
-- resposta do id 64031 pode chegar DEPOIS da do 64040, e `> max(request_id)` pularia a
-- atrasada. O ON CONFLICT torna a repetição gratuita. SECURITY INVOKER: quem roda é o cron
-- (postgres, dono da tabela) — definer aqui só somaria superfície.
CREATE OR REPLACE FUNCTION public.deploy_atestacoes_colher()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO public.deploy_atestacoes (request_id, observado_em, edge, versao, fonte, via)
  SELECT j.request_id, j.observado_em, j.edge, j.versao, j.fonte, j.via
  FROM public.deploy_atestacoes_janela_viva() j
  ON CONFLICT (request_id, observado_em) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.deploy_atestacoes_colher() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deploy_atestacoes_colher() FROM anon;
REVOKE ALL ON FUNCTION public.deploy_atestacoes_colher() FROM authenticated;

-- ------------------------------------------------------------
-- 4. O cron (idempotente: remove antes de re-criar)
-- ------------------------------------------------------------
SELECT cron.unschedule('deploy-atestacoes-colher')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deploy-atestacoes-colher');
SELECT cron.schedule(
  'deploy-atestacoes-colher',
  '*/15 * * * *',
  $$ SELECT public.deploy_atestacoes_colher() $$
);

-- ------------------------------------------------------------
-- 5. Semente: copia a janela ATUAL agora, para o ledger não nascer vazio
-- ------------------------------------------------------------
-- As sondas coladas hoje pelo founder e os ecos dos crons entram já neste Run.
SELECT public.deploy_atestacoes_colher() AS linhas_semeadas;

-- ------------------------------------------------------------
-- 6. Postcondição — relê o catálogo; aborta o Run se algo não pegou
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_n int;
BEGIN
  -- A1: o ledger existe com RLS LIGADA (tabela sem RLS vazaria o histórico de deploy a qualquer role)
  SELECT count(*) INTO v_n FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'deploy_atestacoes' AND c.relrowsecurity;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'A1 FALHOU: public.deploy_atestacoes ausente ou sem RLS — o ledger nao pode existir aberto';
  END IF;

  -- A2: a chave de idempotência é a PK composta (sem ela o coletor duplicaria a janela a cada 15 min)
  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conrelid = 'public.deploy_atestacoes'::regclass AND contype = 'p' AND array_length(conkey, 1) = 2;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'A2 FALHOU: PRIMARY KEY (request_id, observado_em) ausente — o coletor duplicaria linhas a cada passagem';
  END IF;

  -- A3: anon não alcança a tabela; authenticated só SELECT (o resto é do cron)
  IF has_table_privilege('anon', 'public.deploy_atestacoes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.deploy_atestacoes', 'INSERT')
     OR has_table_privilege('authenticated', 'public.deploy_atestacoes', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.deploy_atestacoes', 'DELETE') THEN
    RAISE EXCEPTION 'A3 FALHOU: privilegio aberto no ledger (anon SELECT ou authenticated escrita) — o REVOKE por nome nao pegou';
  END IF;

  -- A4: as duas policies existem (staff lê; service_role tudo)
  SELECT count(*) INTO v_n FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'deploy_atestacoes'
    AND policyname IN ('deploy_atestacoes_select_staff', 'deploy_atestacoes_service_all');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'A4 FALHOU: % de 2 policies no ledger — staff nao leria, ou service_role nao escreveria', v_n;
  END IF;

  -- A5: as 2 funções existem e o coletor está FECHADO para anon e authenticated
  SELECT count(*) INTO v_n FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('deploy_atestacoes_janela_viva', 'deploy_atestacoes_colher');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'A5 FALHOU: % de 2 funcoes criadas — coletor/janela incompletos', v_n;
  END IF;
  IF has_function_privilege('anon', 'public.deploy_atestacoes_colher()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.deploy_atestacoes_colher()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A5 FALHOU: anon/authenticated ainda EXECUTAM o coletor — qualquer usuario escreveria no ledger';
  END IF;

  -- A6: o cron está agendado com o schedule esperado, uma vez só
  SELECT count(*) INTO v_n FROM cron.job
  WHERE jobname = 'deploy-atestacoes-colher' AND schedule = '*/15 * * * *';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'A6 FALHOU: % job(s) deploy-atestacoes-colher com schedule */15 — sem o coletor o ledger nao enche', v_n;
  END IF;

  RAISE NOTICE 'deploy_atestacoes: ledger com RLS + PK (request_id, observado_em), 2 funcoes (coletor fechado), cron 15/15 min — OK';
END
$post$;

COMMIT;
