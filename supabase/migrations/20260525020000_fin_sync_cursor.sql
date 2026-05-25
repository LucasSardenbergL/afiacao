-- ============================================================
-- Cursor de paginação resumível pro sync do financeiro (colacor CR ~292 págs).
--
-- Contexto: o gargalo é a latência da API do Omie (~1s/página), não o banco.
-- A colacor CR (~292 págs ≈ 290s) NÃO cabe em nenhuma invocação de 130s, nem
-- dedicada. Os crons por-entidade (#267) cobrem ~126 págs/run e recomeçam da
-- pág 1 → as ~166 finais nunca sincronizavam.
--
-- Fix: cursor persistido. As actions sync_contas_pagar/receber/movimentacoes
-- (omie-financeiro) agora lêem o next_page daqui, retomam de lá, e gravam o
-- progresso (NULL quando completam). Um cron de continuação a cada 10 min
-- avança só os cursores com next_page pendente → colacor CR fecha em ~3 ciclos
-- (~30 min). Os crons por-entidade do #267 (08h20/14h20) são o "kickoff" de
-- cada passada nova; a continuação termina.
--
-- ⚠️ Requer redeploy do omie-financeiro (lê o cursor). Sem a função nova, esta
-- tabela fica só ociosa (a função degrada pro comportamento sem cursor).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fin_sync_cursor (
  company    text NOT NULL,
  resource   text NOT NULL CHECK (resource IN ('contas_pagar','contas_receber','movimentacoes')),
  next_page  int,                       -- NULL = sem resume pendente (passada completa)
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, resource)
);

-- Índice pro cron de continuação varrer só pendentes.
CREATE INDEX IF NOT EXISTS idx_fin_sync_cursor_pendentes
  ON public.fin_sync_cursor (resource, company)
  WHERE next_page IS NOT NULL;

ALTER TABLE public.fin_sync_cursor ENABLE ROW LEVEL SECURITY;

-- Staff lê (observabilidade).
DROP POLICY IF EXISTS "fin_sync_cursor_select_staff" ON public.fin_sync_cursor;
CREATE POLICY "fin_sync_cursor_select_staff"
  ON public.fin_sync_cursor FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = auth.uid()
              AND role IN ('employee'::public.app_role, 'master'::public.app_role))
  );

-- Service role (sync) escreve.
DROP POLICY IF EXISTS "fin_sync_cursor_service_all" ON public.fin_sync_cursor;
CREATE POLICY "fin_sync_cursor_service_all"
  ON public.fin_sync_cursor FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Cron de continuação: a cada 10 min, avança SÓ os cursores pendentes
-- (next_page IS NOT NULL). Quando todos completam, é no-op. As 3 empresas são
-- contas Omie distintas (rate-limit por conta) → seguras em paralelo.
SELECT cron.schedule(
  'fin-sync-continuacao-10min',
  '*/10 * * * *',
  $cron$
  DO $inner$
  DECLARE r record;
  BEGIN
    FOR r IN
      SELECT company, resource FROM public.fin_sync_cursor WHERE next_page IS NOT NULL
    LOOP
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-financeiro',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
        ),
        body := jsonb_build_object('action', 'sync_' || r.resource, 'company', r.company),
        timeout_milliseconds := 150000
      );
    END LOOP;
  END $inner$;
  $cron$
);
