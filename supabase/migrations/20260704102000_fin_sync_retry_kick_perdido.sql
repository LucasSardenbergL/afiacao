-- ============================================================
-- Retry de kick perdido do fin-sync (incidente 2026-07-04).
--
-- Problema: os kicks 2x (fin-sync-cp/cr/mov-2x) são net.http_post
-- fire-and-forget. Quando o post morre no TRANSPORTE (ex.: 503
-- BOOT_ERROR transitório do Edge Runtime — net._http_response id
-- 24244), a edge nunca boota: zero linha em fin_sync_log, cursor
-- NULL → o continuador */10 (que só retoma cursor pendente) não
-- tem o que fazer e a janela inteira se perde até o próximo kick
-- 2x (6h). CP colacor ficou 19h+ defasado; o Sentinela (sync_stale
-- 18h) gritou tarde. Mesmo padrão nos buracos de 07-01/07-02.
--
-- Fix: um cron DEDICADO fin-sync-retry-kicks (SEPARADO do
-- continuador) re-posta o kick da última janela esperada quando
-- NENHUM sinal existe pós-janela. Desenho decidido com o Codex
-- (challenge 2026-07-04):
--
--   • CRON SEPARADO, não estender o continuador. Isola falhas (um
--     bug no retry não pode matar a continuação de cursor provada
--     em prod) e permite que erro estrutural do retry apareça como
--     FAILED no job_run_details (cron SQL-local).
--   • OFFSET :5 no schedule ('5-55/10' → :05,:15,:25,:35,:45,:55).
--     Os kicks originais são :00 (CP) /:20 (CR) /:40 (mov); o retry
--     NUNCA cai nesses minutos, mesmo se um tick escorregar. A
--     não-colisão vem da CONSTRUÇÃO do schedule, não de math de
--     grace frágil (achado [P1] do Codex: grace+*/10 podia escorregar
--     de :30 p/ :40 e colidir com o mov-kick na mesma conta Omie).
--   • fin_sync_retry_tick() é SÓ o retry (claim+post+higiene). A
--     continuação de cursor segue no fin-sync-continuacao-10min
--     INTOCADO (preserva o mecanismo provado; zero regressão).
--
-- Guards da decisão (fin_sync_kicks_perdidos — precisão>recall, na
-- dúvida NÃO re-kickar):
--   a) qualquer linha em fin_sync_log com started_at >= janela
--      (running/complete/error) prova que o kick CHEGOU — inclusive
--      run que ERROU: erro de execução é outra classe (edge tem
--      retry interno; sync_error alerta), re-kick automático de erro
--      martelaria o Omie. Órfã running de ANTES da janela não bloqueia
--      (o watchdog a converte em error em 30min).
--   b) cursor pendente (o continuador cobre) ou tocado >= janela
--      (passada viva/completada pós-janela) → não re-kickar.
--   c) 1 retry por (company, resource, janela) — anti-tempestade. Se
--      o próprio retry morrer, a rede é o kick da janela seguinte +
--      sync_stale (e o alerta rápido de "retry sem efeito" — tarefa
--      irmã do Sentinela). Elevar p/ N tentativas é iteração futura
--      fácil (o guard-d já protege concorrência) — 1 é o conservador.
--   d) NENHUM sync running recente (<10min) da MESMA empresa — a
--      conta Omie está ocupada → não abrir um 2º sync concorrente
--      (2 syncs na mesma conta = rate-limit FATAL SILENCIOSO). Rede
--      contra o continuador/cron original ainda em voo. A garantia
--      DURA de exclusão por conta é o lease na edge (tarefa irmã);
--      este guard é a mitigação no lado do dispatcher.
--   e) cap: máx 1 retry por EMPRESA por tick (DISTINCT ON company,
--      prioridade CP>CR>mov) — preserva o escalonamento por conta.
--
-- Grace de 30min: kick saudável loga 'running' em segundos; 30min
-- sem NENHUM sinal ⇒ transporte morto (o pg_net não segura request
-- além do timeout de 150s + fila curta, então 30min distingue
-- transporte-morto de in-flight). Também alinha o 1º retry elegível
-- ao slot seguro (CP 08:00 → elegível 08:30 → 1º retry 08:35).
--
-- Janelas esperadas (UTC — ESPELHAM os crons 2x; manter em sincronia
-- se o schedule mudar: CP :00, CR :20, mov :40, horas 8 e 14). Math
-- 100% AT TIME ZONE 'UTC' (independe do TimeZone da sessão). Se um
-- cron 2x mudar de horário sem atualizar esta função, o guard-a
-- (log pós-janela) degrada gracioso: se o novo horário já rodou,
-- há log → não re-kicka.
-- ============================================================

-- 1) Tabela de attempts: 1 retry por janela + auditoria
--    (request_id correlaciona com net._http_response.id).
CREATE TABLE IF NOT EXISTS public.fin_sync_kick_retry (
  company      text NOT NULL,
  resource     text NOT NULL CHECK (resource IN ('contas_pagar','contas_receber','movimentacoes')),
  janela       timestamptz NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  request_id   bigint,
  PRIMARY KEY (company, resource, janela)
);
-- defensivo p/ re-cola no SQL Editor caso a tabela já exista sem a coluna
ALTER TABLE public.fin_sync_kick_retry ADD COLUMN IF NOT EXISTS request_id bigint;

ALTER TABLE public.fin_sync_kick_retry ENABLE ROW LEVEL SECURITY;

-- Staff lê (observabilidade); escrita só pelo tick (postgres/cron).
DROP POLICY IF EXISTS "fin_sync_kick_retry_select_staff" ON public.fin_sync_kick_retry;
CREATE POLICY "fin_sync_kick_retry_select_staff"
  ON public.fin_sync_kick_retry FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = auth.uid()
              AND role IN ('employee'::public.app_role, 'master'::public.app_role))
  );

REVOKE INSERT, UPDATE, DELETE ON public.fin_sync_kick_retry FROM anon, authenticated;

-- 2) Decisão PURA (testável): quais (empresa, resource) perderam o
--    kick da última janela esperada. prio = ordem de retry no tick.
CREATE OR REPLACE FUNCTION public.fin_sync_kicks_perdidos(p_now timestamptz DEFAULT now())
RETURNS TABLE(company text, resource text, janela timestamptz, prio int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH recursos(resource, off_min, prio) AS (
    VALUES ('contas_pagar', 0, 1), ('contas_receber', 20, 2), ('movimentacoes', 40, 3)
  ),
  janelas AS (
    SELECT r.resource, r.prio,
           ((date_trunc('day', p_now AT TIME ZONE 'UTC') - make_interval(days => d.d)
             + make_interval(hours => h.h, mins => r.off_min)) AT TIME ZONE 'UTC') AS janela
    FROM recursos r,
         (VALUES (0),(1)) d(d),
         (VALUES (8),(14)) h(h)
  ),
  ultima_janela AS (
    SELECT j.resource, j.prio, max(j.janela) AS janela
    FROM janelas j
    WHERE j.janela <= p_now - interval '30 minutes'   -- grace
    GROUP BY j.resource, j.prio
  ),
  empresas(company) AS (
    VALUES ('oben'), ('colacor'), ('colacor_sc')
  )
  SELECT e.company, u.resource, u.janela, u.prio
  FROM empresas e
  CROSS JOIN ultima_janela u
  WHERE
    -- (a) nenhum sinal no log pós-janela (qualquer status = kick chegou)
    NOT EXISTS (
      SELECT 1 FROM public.fin_sync_log l
      WHERE l.action = 'sync_' || u.resource
        AND e.company = ANY (l.companies)
        AND l.started_at >= u.janela
    )
    -- (b) cursor pendente (o continuador cobre) ou tocado pós-janela
    AND NOT EXISTS (
      SELECT 1 FROM public.fin_sync_cursor cur
      WHERE cur.company = e.company
        AND cur.resource = u.resource
        AND (cur.next_page IS NOT NULL OR cur.updated_at >= u.janela)
    )
    -- (c) 1 retry por janela
    AND NOT EXISTS (
      SELECT 1 FROM public.fin_sync_kick_retry r
      WHERE r.company = e.company
        AND r.resource = u.resource
        AND r.janela = u.janela
    )
    -- (d) conta Omie ocupada: sync running recente (<10min) da empresa
    AND NOT EXISTS (
      SELECT 1 FROM public.fin_sync_log l
      WHERE e.company = ANY (l.companies)
        AND l.status = 'running'
        AND l.started_at > p_now - interval '10 minutes'
    )
$$;

REVOKE EXECUTE ON FUNCTION public.fin_sync_kicks_perdidos(timestamptz) FROM anon, authenticated, PUBLIC;

-- 3) Retry tick: claim antes do post; higiene isolada.
--    Erro ESTRUTURAL do retry PROPAGA (job_run_details=failed, visível);
--    o claim+post revertem juntos (atômicos) → re-detecta e re-tenta
--    limpo no próximo tick. Só a higiene é best-effort (não derruba).
CREATE OR REPLACE FUNCTION public.fin_sync_retry_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  k record;
  v_req bigint;
  v_url constant text := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro';
BEGIN
  -- anti-sobreposição de dois retry_ticks (auto-libera no fim da transação)
  IF NOT pg_try_advisory_xact_lock(hashtext('fin_sync_retry_tick')::bigint) THEN
    RETURN;
  END IF;

  FOR k IN
    SELECT DISTINCT ON (kp.company) kp.company, kp.resource, kp.janela, kp.prio
    FROM public.fin_sync_kicks_perdidos(now()) kp
    ORDER BY kp.company, kp.prio
  LOOP
    INSERT INTO public.fin_sync_kick_retry (company, resource, janela)
    VALUES (k.company, k.resource, k.janela)
    ON CONFLICT (company, resource, janela) DO NOTHING;
    IF FOUND THEN
      SELECT net.http_post(
        url := v_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
        ),
        body := jsonb_build_object('action', 'sync_' || k.resource, 'company', k.company),
        timeout_milliseconds := 150000
      ) INTO v_req;
      UPDATE public.fin_sync_kick_retry
      SET request_id = v_req
      WHERE company = k.company AND resource = k.resource AND janela = k.janela;
    END IF;
  END LOOP;

  -- higiene: best-effort, nunca derruba o retry
  BEGIN
    DELETE FROM public.fin_sync_kick_retry WHERE attempted_at < now() - interval '30 days';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fin_sync_retry_tick higiene falhou: %', SQLERRM;
  END;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fin_sync_retry_tick() FROM anon, authenticated, PUBLIC;

-- 4) Cron dedicado — offset :5 (nunca colide com os kicks :00/:20/:40).
--    upsert por nome (idempotente).
SELECT cron.schedule(
  'fin-sync-retry-kicks',
  '5-55/10 * * * *',
  $cron$ SELECT public.fin_sync_retry_tick(); $cron$
);
