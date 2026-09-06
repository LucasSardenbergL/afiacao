-- ============================================================
-- deploy_sonda_resultados — o MOTIVO do silêncio, depois que o pg_net esquece (fatia F3)
-- Objetivo: docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md §4.6
-- Contexto:  docs/historico/sonda-por-cron-fail-closed.md
-- Depende de: 20260906151204_deploy_sonda_cron_fail_closed.sql (alvos, disparos, dispatcher, cron)
-- ============================================================
-- POR QUÊ: quando o cron dispara e a edge NÃO atesta, a pergunta que decide o que fazer é *por
-- quê*. As respostas do relé dizem exatamente isso no corpo (`cors-sem-sonda`, `contrato-invalido`,
-- `identidade-divergente`, `redirect`, `timeout`, `erro-http`, `sem-chave`, `barreira`) — mas elas
-- vivem em `net._http_response`, que o `pg_net.ttl` apaga em 6 HORAS. Com o cron rodando de 2 em 2
-- horas, um silêncio percebido na manhã seguinte já perdeu o motivo: sobra "não atestou", que é
-- exatamente a ausência de dado que este mecanismo inteiro existe para não confundir com veredito.
--
-- Esta tabela é o oposto do ledger: `deploy_atestacoes` guarda o que DEU CERTO (e é a prova de
-- deploy); esta guarda o que NÃO deu, com o motivo. Ela NÃO escreve no ledger e o ledger não a
-- consulta — via única preservada.
--
-- Idempotente. Postcondição no fim aborta o Run se algo não pegar.

BEGIN;

-- ------------------------------------------------------------
-- 1. A tabela
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.deploy_sonda_resultados (
  -- Um resultado por DISPARO. A chave é o `request_id` porque é ele que liga ao tick que perguntou
  -- (`deploy_sonda_disparos`) — nunca o tempo, que já fabricou veredito neste repo.
  request_id   bigint      PRIMARY KEY,
  tick_id      uuid        NOT NULL,
  edge         text        NOT NULL,
  -- NULL = o pg_net ainda não tem resposta (enfileirada, ou a coleta rodou antes de chegar).
  -- Ausente ≠ zero: quem lê distingue "sem resposta ainda" de "respondeu 200".
  status_code  integer,
  -- A classe que o RELÉ declarou, ou 'atestou' quando o corpo é a atestação verbatim da alvo.
  -- 'sem-corpo-reconhecido' é o escape honesto: respondeu algo que não é nossa forma.
  classe       text,
  observado_em timestamptz,
  colhido_em   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deploy_sonda_resultados_edge
  ON public.deploy_sonda_resultados (edge, colhido_em DESC);
CREATE INDEX IF NOT EXISTS idx_deploy_sonda_resultados_tick
  ON public.deploy_sonda_resultados (tick_id);

COMMENT ON TABLE public.deploy_sonda_resultados IS
  'Motivo de cada disparo da sonda por cron, preservado além do TTL de 6h do pg_net. Alimentada '
  'pelo cron deploy-sonda-resultados-colher a partir de deploy_sonda_disparos ⋈ net._http_response. '
  'NÃO é prova de deploy — quem prova é public.deploy_atestacoes.';

ALTER TABLE public.deploy_sonda_resultados ENABLE ROW LEVEL SECURITY;
-- ⚠️ `REVOKE … FROM PUBLIC` não tira anon/authenticated (grant explícito do default ACL) — cada
-- role sai por NOME. `service_role` incluído: edge comprometida não reescreve o diagnóstico.
REVOKE ALL ON public.deploy_sonda_resultados FROM PUBLIC;
REVOKE ALL ON public.deploy_sonda_resultados FROM anon;
REVOKE ALL ON public.deploy_sonda_resultados FROM authenticated;
REVOKE ALL ON public.deploy_sonda_resultados FROM service_role;
GRANT SELECT ON public.deploy_sonda_resultados TO authenticated;

DROP POLICY IF EXISTS "deploy_sonda_resultados_select_staff" ON public.deploy_sonda_resultados;
CREATE POLICY "deploy_sonda_resultados_select_staff"
  ON public.deploy_sonda_resultados
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('employee'::public.app_role, 'master'::public.app_role)
    )
  );

-- ------------------------------------------------------------
-- 2. O coletor
-- ------------------------------------------------------------
-- Varre os disparos das últimas 48h e casa com `net._http_response` por `request_id`. Insere o que
-- falta e ATUALIZA o que ainda estava sem resposta (o disparo entra na tabela antes de a resposta
-- existir; a atualização é o que completa a linha quando ela chega).
--
-- O cast para jsonb vive num CASE, e os filtros textuais vêm ANTES: ordem de avaliação é da
-- LINGUAGEM, não do plano. Um corpo truncado que comece com `{` abortaria a varredura inteira.
CREATE OR REPLACE FUNCTION public.deploy_sonda_resultados_colher()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  v_n integer;
BEGIN
  WITH candidatos AS (
    SELECT d.request_id, d.tick_id, d.edge,
           r.status_code, r.created,
           CASE WHEN r.content IS NOT NULL
                     AND left(ltrim(r.content), 1) = '{'
                     AND r.content IS JSON OBJECT
                THEN r.content::jsonb END AS c
    FROM public.deploy_sonda_disparos d
    LEFT JOIN net._http_response r ON r.id = d.request_id
    WHERE d.enfileirado_em > now() - interval '48 hours'
  ), classificados AS (
    SELECT request_id, tick_id, edge, status_code, created,
           CASE
             WHEN c IS NULL THEN NULL
             -- A atestação: o relé só repassa o corpo verbatim quando ele passa no contrato COMPLETO.
             WHEN (c -> 'probe') = to_jsonb(true) AND jsonb_typeof(c -> 'edge') = 'string' THEN 'atestou'
             WHEN jsonb_typeof(c -> 'classe') = 'string' THEN c ->> 'classe'
             ELSE 'sem-corpo-reconhecido'
           END AS classe
    FROM candidatos
  )
  INSERT INTO public.deploy_sonda_resultados (request_id, tick_id, edge, status_code, classe, observado_em)
  SELECT request_id, tick_id, edge, status_code, classe, created
  FROM classificados
  ON CONFLICT (request_id) DO UPDATE
    SET status_code = EXCLUDED.status_code,
        classe = EXCLUDED.classe,
        observado_em = EXCLUDED.observado_em,
        colhido_em = now()
    -- Só atualiza quando há novidade: sem isto, cada passagem reescreveria 100% das linhas e o
    -- `colhido_em` deixaria de significar "quando este resultado apareceu".
    WHERE public.deploy_sonda_resultados.classe IS DISTINCT FROM EXCLUDED.classe
       OR public.deploy_sonda_resultados.status_code IS DISTINCT FROM EXCLUDED.status_code;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$fn$;

COMMENT ON FUNCTION public.deploy_sonda_resultados_colher() IS
  'Copia o RESULTADO de cada disparo da sonda (48h) de net._http_response para '
  'public.deploy_sonda_resultados, preservando o motivo além do TTL de 6h do pg_net.';

REVOKE ALL ON FUNCTION public.deploy_sonda_resultados_colher() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.deploy_sonda_resultados_colher() FROM anon;
REVOKE ALL ON FUNCTION public.deploy_sonda_resultados_colher() FROM authenticated;
REVOKE ALL ON FUNCTION public.deploy_sonda_resultados_colher() FROM service_role;

-- ------------------------------------------------------------
-- 3. O cron (idempotente) + semeadura da janela atual
-- ------------------------------------------------------------
-- 12/12 min, deslocado do coletor do ledger (que roda em */15) para não competirem pelo mesmo
-- minuto. O período é bem menor que as 6h do TTL: a resposta é colhida muitas vezes antes de sumir.
SELECT cron.unschedule('deploy-sonda-resultados-colher')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'deploy-sonda-resultados-colher');
SELECT cron.schedule(
  'deploy-sonda-resultados-colher',
  '*/12 * * * *',
  $$ SELECT public.deploy_sonda_resultados_colher() $$
);

SELECT public.deploy_sonda_resultados_colher() AS linhas_semeadas;

-- ------------------------------------------------------------
-- 4. Postcondição
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'deploy_sonda_resultados' AND c.relrowsecurity;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'A1 FALHOU: deploy_sonda_resultados ausente ou sem RLS — o diagnostico da sonda nao pode existir aberto';
  END IF;

  IF has_table_privilege('anon', 'public.deploy_sonda_resultados', 'SELECT')
     OR has_table_privilege('authenticated', 'public.deploy_sonda_resultados', 'INSERT')
     OR has_table_privilege('service_role', 'public.deploy_sonda_resultados', 'UPDATE') THEN
    RAISE EXCEPTION 'A2 FALHOU: privilegio aberto em deploy_sonda_resultados — o REVOKE por nome nao pegou';
  END IF;

  SELECT count(*) INTO v_n FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'deploy_sonda_resultados_colher';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'A3 FALHOU: o coletor de resultados nao existe — a tabela nunca encheria';
  END IF;
  IF has_function_privilege('anon', 'public.deploy_sonda_resultados_colher()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.deploy_sonda_resultados_colher()', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.deploy_sonda_resultados_colher()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: anon/authenticated/service_role EXECUTAM o coletor de resultados';
  END IF;

  SELECT count(*) INTO v_n FROM cron.job
  WHERE jobname = 'deploy-sonda-resultados-colher' AND schedule = '*/12 * * * *'
    AND username = 'postgres' AND database = current_database();
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'A4 FALHOU: % job(s) deploy-sonda-resultados-colher com schedule/owner esperados', v_n;
  END IF;

  -- A5: a dependência que o coletor usa em RUNTIME existe AGORA. PL/pgSQL é late-bound: sem este
  -- assert o CREATE passaria e a função só quebraria no primeiro tick.
  IF to_regclass('public.deploy_sonda_disparos') IS NULL THEN
    RAISE EXCEPTION 'A5 FALHOU: public.deploy_sonda_disparos nao existe — aplique antes a migration 20260906151204_deploy_sonda_cron_fail_closed.sql';
  END IF;

  RAISE NOTICE 'deploy_sonda_resultados: tabela com RLS + ACL fechada, coletor fechado, cron */12 — OK';
END
$post$;

COMMIT;
