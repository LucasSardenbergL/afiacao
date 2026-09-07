-- ============================================================
-- Sonda de deploy POR CRON, fail-closed no bundle velho — o lado do BANCO (fatia F2)
-- Objetivo: docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md §4.5
-- Contexto:  docs/historico/sonda-por-cron-fail-closed.md
-- Depende de: 20260905183314_deploy_atestacoes_ledger_e_sonda_cron.sql (o ledger + o coletor)
--             e do deploy da edge `sonda-relay` (F1, PR #2235)
-- ============================================================
-- POR QUÊ: a única prova de qual bundle está em produção é a resposta da edge, e até aqui ela era
-- HUMANA — o founder colava um bloco de sonda a cada leva de deploy. Automatizar isso por POST era
-- INSEGURO e foi derrubado: um bundle que não conhece o classificador executa o FLUXO REAL (a
-- `monthly-report` manda e-mail para 5.276 perfis). Pior, MEDIDO: existem bundles históricos que
-- não autenticam NADA (`monthly-report@ef08dddd2` produz 2 efeitos e chega ao Resend para um POST
-- vazio; `calculate-scores@45a80118b`, 11 efeitos) — então nem uma credencial nova em header
-- resolveria: ninguém checa credencial ali.
--
-- O que TODO bundle interrompe antes de qualquer IO é o `OPTIONS` (preflight de CORS, primeira
-- instrução do handler desde sempre). O `pg_net` não emite `OPTIONS` (0.19.5: só GET/POST/DELETE),
-- então este cron faz POST na edge-RELÉ `sonda-relay`, e é ELA que emite o `OPTIONS` na alvo com a
-- credencial de sonda. Nada aqui fala com a edge-alvo diretamente.
--
-- 3 objetos + 1 cron, e a divisão de trabalho:
--   1. public.deploy_sonda_alvos     — o ESPELHO da allowlist do repo (default-deny). O relé também
--      tem a lista dele; esta existe para o operador poder DESLIGAR uma edge sem deploy.
--   2. public.deploy_sonda_disparos  — a ATRIBUIÇÃO. Cada disparo grava (tick_id, edge, request_id)
--      na MESMA transação do `net.http_post`, e é por `request_id` que o CLI (F3) liga a resposta
--      do ledger ao tick que a pediu. Sem isso, uma resposta atrasada do tick anterior ou uma sonda
--      manual mascarariam dois ticks silenciosos depois de um rollback.
--   3. public.deploy_sonda_disparar() — o dispatcher.
--   4. cron `deploy-sonda-cron` (37 */2 * * *) — o minuto 37 está livre entre os 94 jobs.
--
-- A RESPOSTA não é escrita aqui: ela cai em `net._http_response` e o cron `deploy-atestacoes-colher`
-- (15/15 min, já no ar) a copia para `public.deploy_atestacoes`. VIA ÚNICA — nenhum objeto novo
-- escreve no ledger.
--
-- Idempotente: pode ser colada mais de uma vez. Postcondição no fim aborta o Run se algo faltar.

BEGIN;

-- ------------------------------------------------------------
-- 1. O espelho da allowlist (default-deny)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deploy_sonda_alvos (
  edge          text        PRIMARY KEY CHECK (edge ~ '^[a-z0-9-]{1,80}$'),
  -- Kill switch POR EDGE, sem migration e sem deploy: `UPDATE … SET ativo = false WHERE edge = …`.
  ativo         boolean     NOT NULL DEFAULT true,
  habilitado_em timestamptz NOT NULL DEFAULT now(),
  -- Por que esta edge pode ser sondada. A resposta honesta é sempre a mesma: porque
  -- `bun run sonda:cron-prova` executou 100 % dos closures históricos dela e contou zero efeito.
  motivo        text        NOT NULL
);

COMMENT ON TABLE public.deploy_sonda_alvos IS
  'Espelho da allowlist da sonda por cron (fonte única: supabase/functions/_shared/sonda-cron-alvos.ts). '
  'Uma edge só entra aqui depois de `bun run sonda:cron-prova` aprovar TODOS os closures históricos '
  'dela. O CLI `pendencias:deploy` exige banco ⊆ repo.';

ALTER TABLE public.deploy_sonda_alvos ENABLE ROW LEVEL SECURITY;

-- Fechada por PRIVILÉGIO, e não só por policy. ⚠️ `REVOKE … FROM PUBLIC` NÃO tira anon/authenticated
-- (eles têm grant explícito pelo default ACL do Supabase) — por isso cada role é revogada POR NOME.
-- `service_role` também sai: uma edge comprometida não pode desativar sondas nem ampliar o fan-out.
REVOKE ALL ON public.deploy_sonda_alvos FROM PUBLIC;
REVOKE ALL ON public.deploy_sonda_alvos FROM anon;
REVOKE ALL ON public.deploy_sonda_alvos FROM authenticated;
REVOKE ALL ON public.deploy_sonda_alvos FROM service_role;
GRANT SELECT ON public.deploy_sonda_alvos TO authenticated;

DROP POLICY IF EXISTS "deploy_sonda_alvos_select_staff" ON public.deploy_sonda_alvos;
CREATE POLICY "deploy_sonda_alvos_select_staff"
  ON public.deploy_sonda_alvos
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('employee'::public.app_role, 'master'::public.app_role)
    )
  );

-- ------------------------------------------------------------
-- 2. A atribuição: qual request_id saiu de qual tick, para qual edge
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deploy_sonda_disparos (
  -- O id devolvido por `net.http_post`. É SÍNCRONO (a fila só é processada após o COMMIT), então a
  -- linha existe antes de qualquer resposta chegar — é isso que torna a atribuição confiável.
  request_id    bigint      PRIMARY KEY,
  tick_id       uuid        NOT NULL,
  edge          text        NOT NULL,
  enfileirado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deploy_sonda_disparos_tick
  ON public.deploy_sonda_disparos (tick_id, edge);
CREATE INDEX IF NOT EXISTS idx_deploy_sonda_disparos_edge_quando
  ON public.deploy_sonda_disparos (edge, enfileirado_em DESC);

COMMENT ON TABLE public.deploy_sonda_disparos IS
  'Um registro por disparo da sonda por cron: liga (tick_id, edge) ao request_id do pg_net, gravado '
  'na MESMA transação do http_post. É por aqui que `pendencias:deploy` sabe que a linha do ledger '
  'responde a ESTE tick — resposta atrasada ou sonda manual têm outro id e não contam.';

ALTER TABLE public.deploy_sonda_disparos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deploy_sonda_disparos FROM PUBLIC;
REVOKE ALL ON public.deploy_sonda_disparos FROM anon;
REVOKE ALL ON public.deploy_sonda_disparos FROM authenticated;
REVOKE ALL ON public.deploy_sonda_disparos FROM service_role;
GRANT SELECT ON public.deploy_sonda_disparos TO authenticated;

DROP POLICY IF EXISTS "deploy_sonda_disparos_select_staff" ON public.deploy_sonda_disparos;
CREATE POLICY "deploy_sonda_disparos_select_staff"
  ON public.deploy_sonda_disparos
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('employee'::public.app_role, 'master'::public.app_role)
    )
  );

-- ------------------------------------------------------------
-- 3. O dispatcher
-- ------------------------------------------------------------
-- SECURITY INVOKER: quem executa é o cron (postgres, dono das tabelas) ou o founder no SQL Editor.
-- DEFINER aqui só somaria superfície — não há nada que o invocador legítimo não possa fazer.
--
-- O laço é PL/pgSQL de propósito, e não um `SELECT … WHERE ativo` com o `http_post` na projeção:
-- proteger disparo por `WHERE` é dependente de PLANO (medido neste repo — sob agregação o filtro
-- desce depois e a função VOLÁTIL dispara mesmo com a trava fechada). `FOR … IN SELECT … LOOP` é
-- semântica da linguagem: o corpo só roda para as linhas que o SELECT devolveu.
CREATE OR REPLACE FUNCTION public.deploy_sonda_disparar(p_alvos text[] DEFAULT NULL)
RETURNS TABLE (tick_id uuid, edge text, request_id bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_tick    uuid := gen_random_uuid();
  v_secret  text;
  v_n       integer;
  v_edge    text;
  v_req     bigint;
BEGIN
  -- O segredo do CRON tem de ser ÚNICO e não-vazio. Duas linhas com o mesmo nome tornariam o
  -- `SELECT INTO` arbitrário — o dispatcher passaria a autenticar com um valor que ninguém escolheu,
  -- e o sintoma seria 401 no relé, intermitente e inexplicável. Zero linhas é o caso trivial.
  SELECT count(*), max(s.decrypted_secret) INTO v_n, v_secret
  FROM vault.decrypted_secrets s
  WHERE s.name = 'CRON_SECRET'
    AND s.decrypted_secret IS NOT NULL
    AND s.decrypted_secret <> '';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'deploy_sonda_disparar: esperava EXATAMENTE 1 CRON_SECRET nao vazio no vault, achei % — nenhum disparo feito', v_n;
  END IF;

  FOR v_edge IN
    SELECT a.edge
    FROM public.deploy_sonda_alvos a
    WHERE a.ativo
      AND (p_alvos IS NULL OR a.edge = ANY (p_alvos))
    ORDER BY a.edge
  LOOP
    -- Headers: SÓ o que o relé precisa. Nenhuma credencial de sonda sai daqui — quem a deriva é o
    -- relé, a partir de `SONDA_HMAC_KEY`, que vive só nos secrets das edges e o banco nem conhece.
    SELECT net.http_post(
             url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sonda-relay',
             headers := jsonb_build_object(
               'Content-Type', 'application/json',
               'x-cron-secret', v_secret),
             body := jsonb_build_object('alvo', v_edge, 'tick', v_tick::text),
             timeout_milliseconds := 20000)
      INTO v_req;

    -- MESMA transação do post: o pg_net só envia após o COMMIT, então não existe janela em que a
    -- resposta chegue sem a linha de atribuição já estar aqui.
    --
    -- ⚠️ `WHERE NOT EXISTS` e não `ON CONFLICT (request_id)`: `request_id` é também uma coluna de
    -- SAÍDA desta função (RETURNS TABLE), e o `ON CONFLICT` não aceita qualificação — o Postgres
    -- rejeita com "column reference is ambiguous" em RUNTIME, não no CREATE. Aqui o `d.request_id`
    -- é qualificado e a ambiguidade não existe.
    INSERT INTO public.deploy_sonda_disparos (request_id, tick_id, edge)
    SELECT v_req, v_tick, v_edge
    WHERE NOT EXISTS (
      SELECT 1 FROM public.deploy_sonda_disparos d WHERE d.request_id = v_req
    );

    tick_id := v_tick;
    edge := v_edge;
    request_id := v_req;
    RETURN NEXT;
  END LOOP;
END
$fn$;

COMMENT ON FUNCTION public.deploy_sonda_disparar(text[]) IS
  'Dispara a sonda por cron: um POST na edge-relé sonda-relay por alvo ATIVO, gravando a atribuição '
  '(tick_id, edge, request_id). Sem argumento sonda todos os ativos; com p_alvos, só os nomeados. '
  'O relé é quem emite o OPTIONS na alvo — nada aqui fala com a edge-alvo.';

REVOKE ALL ON FUNCTION public.deploy_sonda_disparar(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deploy_sonda_disparar(text[]) FROM anon;
REVOKE ALL ON FUNCTION public.deploy_sonda_disparar(text[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.deploy_sonda_disparar(text[]) FROM service_role;

-- ------------------------------------------------------------
-- 4. Semente da allowlist — as 3 edges aprovadas na F1
-- ------------------------------------------------------------
-- Espelha `supabase/functions/_shared/sonda-cron-alvos.ts`. Um gate do CI (G4) reprova qualquer
-- INSERT aqui com slug que não esteja lá.
INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES
  ('sonda-relay',      'F1 (PR #2235): 5/5 closures historicos executados com zero efeito ao OPTIONS; o rele tambem se atesta'),
  ('monthly-report',   'F1 (PR #2235): 33/33 closures, incluindo ef08dddd2 (SEM gate, 2 efeitos no controle positivo)'),
  ('calculate-scores', 'F1 (PR #2235): 46/46 closures, incluindo 45a80118b (SEM gate, 11 efeitos no controle positivo)')
ON CONFLICT (edge) DO NOTHING;

-- ------------------------------------------------------------
-- 5. O cron (idempotente: remove antes de re-criar)
-- ------------------------------------------------------------
-- 2 em 2 horas, minuto 37 (livre entre os 94 jobs — evita a fila do minuto 0, que tem 36).
-- Cadência é KNOB, não invariante: 3 sondas a cada 2 h ≈ 36/dia. Kill switch global:
--   SELECT cron.unschedule('deploy-sonda-cron');
SELECT cron.unschedule('deploy-sonda-cron')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deploy-sonda-cron');
SELECT cron.schedule(
  'deploy-sonda-cron',
  '37 */2 * * *',
  $$ SELECT public.deploy_sonda_disparar() $$
);

-- ------------------------------------------------------------
-- 6. Postcondição — relê o catálogo; aborta o Run se algo não pegou
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_n int;
BEGIN
  -- A1: as 2 tabelas existem com RLS LIGADA (tabela sem RLS vazaria a lista de alvos e o histórico
  -- de disparos para qualquer role autenticado)
  SELECT count(*) INTO v_n FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('deploy_sonda_alvos', 'deploy_sonda_disparos')
    AND c.relrowsecurity;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'A1 FALHOU: % de 2 tabelas com RLS ligada — nenhuma delas pode existir aberta', v_n;
  END IF;

  -- A2: a PK de disparos é o request_id (sem ela o mesmo id entraria duas vezes e a atribuição
  -- deixaria de ser função)
  SELECT count(*) INTO v_n FROM pg_constraint
  WHERE conrelid = 'public.deploy_sonda_disparos'::regclass
    AND contype = 'p' AND array_length(conkey, 1) = 1;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'A2 FALHOU: PRIMARY KEY (request_id) ausente em deploy_sonda_disparos — a atribuicao deixaria de ser unica';
  END IF;

  -- A3: nenhuma das 4 roles alcança as tabelas para escrita, e anon nem lê
  IF has_table_privilege('anon', 'public.deploy_sonda_alvos', 'SELECT')
     OR has_table_privilege('anon', 'public.deploy_sonda_disparos', 'SELECT')
     OR has_table_privilege('authenticated', 'public.deploy_sonda_alvos', 'INSERT')
     OR has_table_privilege('authenticated', 'public.deploy_sonda_alvos', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.deploy_sonda_alvos', 'DELETE')
     OR has_table_privilege('authenticated', 'public.deploy_sonda_disparos', 'INSERT')
     OR has_table_privilege('service_role', 'public.deploy_sonda_alvos', 'UPDATE')
     OR has_table_privilege('service_role', 'public.deploy_sonda_disparos', 'INSERT') THEN
    RAISE EXCEPTION 'A3 FALHOU: privilegio aberto nas tabelas da sonda (anon lendo, ou authenticated/service_role escrevendo) — o REVOKE por nome nao pegou';
  END IF;

  -- A4: as 2 policies de leitura por staff existem
  SELECT count(*) INTO v_n FROM pg_policies
  WHERE schemaname = 'public'
    AND policyname IN ('deploy_sonda_alvos_select_staff', 'deploy_sonda_disparos_select_staff');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'A4 FALHOU: % de 2 policies de leitura — staff nao conseguiria auditar a sonda', v_n;
  END IF;

  -- A5: o dispatcher existe e está FECHADO para as 4 roles
  SELECT count(*) INTO v_n FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'deploy_sonda_disparar';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'A5 FALHOU: deploy_sonda_disparar ausente — o cron nao teria o que chamar';
  END IF;
  IF has_function_privilege('anon', 'public.deploy_sonda_disparar(text[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.deploy_sonda_disparar(text[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.deploy_sonda_disparar(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'A5 FALHOU: anon/authenticated/service_role ainda EXECUTAM o dispatcher — qualquer um dispararia a sonda';
  END IF;

  -- A6: o cron está agendado UMA vez, com o schedule e o comando esperados, como postgres e neste
  -- database (job criado por usuario/database errados roda em outro lugar e o silêncio parece bug)
  SELECT count(*) INTO v_n FROM cron.job
  WHERE jobname = 'deploy-sonda-cron'
    AND schedule = '37 */2 * * *'
    AND command LIKE '%deploy_sonda_disparar%'
    AND username = 'postgres'
    AND database = current_database();
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'A6 FALHOU: % job(s) deploy-sonda-cron com schedule/comando/owner esperados — sem ele nao ha sonda automatica', v_n;
  END IF;

  -- A7: a semente entrou e a allowlist não tem slug fora de formato
  SELECT count(*) INTO v_n FROM public.deploy_sonda_alvos WHERE ativo;
  IF v_n < 3 THEN
    RAISE EXCEPTION 'A7 FALHOU: % alvo(s) ativo(s), esperava >= 3 — a semente nao entrou', v_n;
  END IF;

  -- A8: as dependências que o dispatcher usa em RUNTIME existem AGORA (PL/pgSQL é late-bound: sem
  -- este assert, `CREATE` passaria e a função só quebraria no primeiro tick, de madrugada)
  IF to_regclass('public.deploy_atestacoes') IS NULL THEN
    RAISE EXCEPTION 'A8 FALHOU: o ledger public.deploy_atestacoes nao existe — aplique antes a migration 20260905183314_deploy_atestacoes_ledger_e_sonda_cron.sql';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'net' AND p.proname = 'http_post';
  IF v_n < 1 THEN
    RAISE EXCEPTION 'A8 FALHOU: net.http_post ausente — a extensao pg_net nao esta instalada';
  END IF;

  RAISE NOTICE 'deploy_sonda_cron: 2 tabelas com RLS + ACL fechada, dispatcher fechado, cron 37 */2 como postgres, % alvo(s) ativo(s) — OK', (SELECT count(*) FROM public.deploy_sonda_alvos WHERE ativo);
END
$post$;

COMMIT;
