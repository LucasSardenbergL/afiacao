-- ============================================================
-- vendas_sync_cursor — cursor + lease pro BACKFILL confiável de pedidos do Omie.
--
-- Contexto (spec docs/superpowers/specs/2026-06-17-vendas-omie-cursor-lease-design.md,
-- §4.2): o backfill de pedidos (omie-vendas-sync / sync_pedidos → sales_orders,
-- MONEY-PATH: positivação/OTE/comissão) é frágil porque o edge (1) colapsa
-- rate-limit e fim-de-página no mesmo `null` (pode parar no meio achando que
-- acabou), (2) não tem serialização real (só o intervalo de cron, e o edge roda
-- em background além do timeout → concorrência → rate-limit silencioso), e (3)
-- valida completude por contagem (prova crescimento, não completude).
--
-- Esta tabela é a FUNDAÇÃO do conserto (Opção A aprovada — cursor + lease +
-- null-discriminado, mantendo insert-only):
--   • cursor por janela (account, date_from, date_to) → retoma do next_page.
--   • completed_at só fecha com FIM REAL (null-discriminado no edge), nunca por
--     total_de_paginas (que mente — CLAUDE.md) nem por contagem.
--   • lease atômico (running_since/heartbeat_at) = serialização REAL: 1 invocação
--     viva por janela. O cron de continuação dispara 1 janela POR CONTA (a mais
--     antiga pendente) → mesma conta serializada, contas distintas em paralelo
--     (rate-limit do Omie é por conta).
--
-- O state-machine do cursor vive em 3 RPCs SQL (lease_acquire/heartbeat/finish),
-- não em UPDATEs do edge — (a) o lease atômico EXIGE a cláusula
-- `running_since IS NULL OR heartbeat_at < now()-3min`, e `.or()` em UPDATE do
-- PostgREST quebra com 42703 (CLAUDE.md) → RPC SQL-pura; (b) assim o state-machine
-- inteiro é provável no PG17 (prove-sql-money-path) antes de ir a produção.
--
-- ⚠️ Espelha 20260525020000_fin_sync_cursor.sql (RLS staff-lê/service-escreve) e
-- REQUER redeploy do omie-vendas-sync (que passa a ler/gravar o cursor). Sem o
-- edge novo, a tabela fica ociosa e o cron */6 é no-op (nenhuma janela semeada).
-- Semear janelas = humano cola (sub-projeto 2), gate humano (spec §6).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.vendas_sync_cursor (
  account        text NOT NULL CHECK (account IN ('oben','colacor')),
  date_from      date NOT NULL,
  date_to        date NOT NULL,
  next_page      int,                       -- NULL = sem resume pendente (janela fechada)
  completed_at   timestamptz,               -- NULL até a janela fechar de VERDADE (fim real null-discriminado)
  last_error_kind text CHECK (last_error_kind IS NULL OR last_error_kind IN ('rate_limit','transient','http','error')),
  running_since  timestamptz,               -- NULL = livre (lease)
  heartbeat_at   timestamptz,               -- renovado por página (detecta lease morto > 3 min)
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, date_from, date_to)
);

-- Índice pro cron de continuação varrer SÓ pendentes (janela aberta).
-- Predicado do spec; (account, date_from) serve o DISTINCT ON (account) ORDER BY date_from do cron.
CREATE INDEX IF NOT EXISTS idx_vendas_sync_cursor_pendentes
  ON public.vendas_sync_cursor (account, date_from)
  WHERE next_page IS NOT NULL OR completed_at IS NULL;

-- ─────────────────────────── RLS (espelha fin_sync_cursor) ───────────────────────────
ALTER TABLE public.vendas_sync_cursor ENABLE ROW LEVEL SECURITY;

-- Staff lê (observabilidade: eu monitoro o cursor real via psql-ro, não por contagem).
DROP POLICY IF EXISTS "vendas_sync_cursor_select_staff" ON public.vendas_sync_cursor;
CREATE POLICY "vendas_sync_cursor_select_staff"
  ON public.vendas_sync_cursor FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = auth.uid()
              AND role IN ('employee'::public.app_role, 'master'::public.app_role))
  );

-- Service role (sync/cron) escreve.
DROP POLICY IF EXISTS "vendas_sync_cursor_service_all" ON public.vendas_sync_cursor;
CREATE POLICY "vendas_sync_cursor_service_all"
  ON public.vendas_sync_cursor FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─────────────────────────── State-machine do cursor (RPC SQL) ───────────────────────────
-- SECURITY DEFINER (bypassa RLS internamente) + gate na FRONTEIRA via REVOKE/GRANT
-- (só service_role executa — é o edge). search_path pinado (anti-hijack).

-- (1) lease_acquire: tenta tomar o lease ATOMICAMENTE. Retorna a página de
-- retomada se conseguiu; NULL se NÃO conseguiu (outra invocação viva, ou janela
-- já completa, ou janela inexistente). É o coração da serialização real.
CREATE OR REPLACE FUNCTION public.vendas_sync_lease_acquire(
  p_account text, p_date_from date, p_date_to date
) RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET running_since = now(), heartbeat_at = now(), updated_at = now()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND completed_at IS NULL
     AND (running_since IS NULL OR heartbeat_at < now() - interval '3 minutes')
  RETURNING COALESCE(next_page, 1);
$$;

-- (2) heartbeat: renova o lease E PERSISTE o progresso por página (next_page := a
-- página EM CURSO). Mantém o lease vivo no run longo (>3min de steal) e — crucial —
-- garante que um crash/erro inesperado retome da página em curso, re-fazendo no
-- máximo 1 página (idempotente via uniq_sales_orders_omie_hash), nunca o run inteiro
-- (achado Codex cursor-finish-rewind). Só age se a janela tem lease ativo
-- (running_since IS NOT NULL). 0 linhas = janela liberada/roubada.
CREATE OR REPLACE FUNCTION public.vendas_sync_heartbeat(
  p_account text, p_date_from date, p_date_to date, p_page integer
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET heartbeat_at = now(), next_page = p_page, updated_at = now()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND running_since IS NOT NULL;
$$;

-- (2b) release: LIBERA o lease (running_since := NULL) preservando o next_page (o
-- progresso que o heartbeat persistiu). É o caminho do erro INESPERADO escapado do
-- edge: solta o lease + grava o kind, mas NÃO rebobina o next_page nem completa.
-- Difere do finish (que decide next_page/completed_at) — aqui o progresso já está no
-- cursor pelo heartbeat e deve ser preservado.
CREATE OR REPLACE FUNCTION public.vendas_sync_release(
  p_account text, p_date_from date, p_date_to date, p_last_error_kind text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET running_since = NULL, last_error_kind = p_last_error_kind,
         heartbeat_at = now(), updated_at = now()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to;
$$;

-- (3) finish: encerra a invocação e LIBERA o lease (running_since := NULL) SEMPRE.
--   p_complete = true  → fim REAL (null-discriminado): next_page := NULL,
--                        completed_at := now(), last_error_kind := NULL.
--   p_complete = false → pausa (budget de página esgotado, transitório, ou erro):
--                        next_page := p_next_page (retoma daqui), grava last_error_kind.
-- completed_at NUNCA é setado com p_complete=false → completude só com fim real.
CREATE OR REPLACE FUNCTION public.vendas_sync_finish(
  p_account text, p_date_from date, p_date_to date,
  p_complete boolean, p_next_page integer, p_last_error_kind text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET next_page       = CASE WHEN p_complete THEN NULL ELSE p_next_page END,
         completed_at     = CASE WHEN p_complete THEN now() ELSE completed_at END,
         last_error_kind  = CASE WHEN p_complete THEN NULL ELSE p_last_error_kind END,
         running_since    = NULL,
         heartbeat_at     = now(),
         updated_at       = now()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to;
$$;

-- Gate na fronteira: só service_role (o edge) executa o state-machine.
REVOKE ALL ON FUNCTION public.vendas_sync_lease_acquire(text, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendas_sync_heartbeat(text, date, date, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendas_sync_finish(text, date, date, boolean, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vendas_sync_release(text, date, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendas_sync_lease_acquire(text, date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.vendas_sync_heartbeat(text, date, date, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.vendas_sync_finish(text, date, date, boolean, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.vendas_sync_release(text, date, date, text) TO service_role;

-- ─────────────────────────── Cron de continuação (*/6) ───────────────────────────
-- A cada 6 min, dispara 1 janela POR CONTA (a mais antiga pendente) → mesma conta
-- serializada pelo lease (tick novo no-opa se a invocação anterior ainda roda),
-- contas distintas em paralelo. No-op enquanto não houver janela semeada.
-- timeout_milliseconds explícito (default 5s mataria silencioso — CLAUDE.md/sync.md);
-- o edge roda em background ALÉM desse timeout, o lease é quem serializa de verdade.
SELECT cron.unschedule('vendas-sync-continuacao-6min')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vendas-sync-continuacao-6min');
SELECT cron.schedule(
  'vendas-sync-continuacao-6min',
  '*/6 * * * *',
  $cron$
  DO $inner$
  DECLARE r record;
  BEGIN
    FOR r IN
      SELECT DISTINCT ON (account) account, date_from, date_to
        FROM public.vendas_sync_cursor
       WHERE completed_at IS NULL
       ORDER BY account, date_from
    LOOP
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-vendas-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
        ),
        body := jsonb_build_object(
          'action', 'sync_pedidos',
          'account', r.account,
          'date_from', to_char(r.date_from, 'DD/MM/YYYY'),
          'date_to',   to_char(r.date_to,   'DD/MM/YYYY'),
          'use_cursor', true,
          'max_pages', 10
        ),
        timeout_milliseconds := 150000
      );
    END LOOP;
  END $inner$;
  $cron$
);
