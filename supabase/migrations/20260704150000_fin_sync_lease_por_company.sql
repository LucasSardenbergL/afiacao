-- ============================================================
-- fin_sync_lease — single-flight POR COMPANY (conta Omie) do omie-financeiro.
--
-- Achado P1 (Codex, 2026-07-04): syncs concorrentes na MESMA conta Omie causam
-- rate-limit FATAL e SILENCIOSO — o callOmie esgota retries, retorna null, a edge
-- trata como "página vazia = fim" e grava status=complete com synced=0 (MENTE
-- conclusão; recebíveis/DRE/caixa congelam sem alerta). Rate-limit do Omie é por
-- CONTA (= company; cada company tem app_key própria). Hoje NÃO há single-flight:
-- kickoffs por-entidade + continuação de cursor (*/10) + retry de kick perdido
-- (fin_sync_tick) podem disparar sync_contas_*/movimentacoes da mesma company ao
-- mesmo tempo. PROVADO em prod: CR colacor 08:50:04→20 sobrepondo mov 08:50:06→41,
-- ambos complete. Design: docs/superpowers/specs/2026-07-04-fin-sync-lease-por-company-design.md
--
-- Espelha o padrão da casa vendas_sync_cursor (20260617133633): lease atômico via
-- RPC SQL-pura (o `.or()`/predicado em UPDATE do PostgREST quebra 42703 — CLAUDE.md),
-- SECURITY DEFINER + search_path pinado, gate na fronteira via REVOKE/GRANT
-- service_role, provável no PG17 (db/test-fin-sync-lease.sh) antes de produção.
--
-- Diferença vs vendas: o lease é POR COMPANY (conta), não por (company,resource).
-- Reusar fin_sync_cursor (granularidade company+resource) daria leases distintos p/
-- cp e cr da mesma company → não se bloqueariam. Logo: tabela dedicada, company = PK.
--
-- ⚠️ REQUER redeploy do omie-financeiro (que passa a acquire/release em torno de
-- sync_all/sync_contas_pagar/sync_contas_receber/sync_movimentacoes). Migration
-- ANTES da edge (a edge nova chama a RPC; a edge velha ignora a tabela — no-op).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fin_sync_lease (
  company     text PRIMARY KEY CHECK (company IN ('oben','colacor','colacor_sc')),
  token       uuid NOT NULL,               -- gerado por acquire; release é token-guarded
  holder      text,                        -- logId da invocação que segura (observabilidade)
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,        -- lease LIVRE quando expires_at <= now() (TTL)
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fin_sync_lease IS
  'Single-flight por conta Omie (company) do omie-financeiro. 1 linha por company; lease livre quando expires_at<=now(). Ver 20260704150000 e a spec fin-sync-lease-por-company.';

-- ─────────────────────────── RLS (espelha fin_sync_cursor) ───────────────────────────
ALTER TABLE public.fin_sync_lease ENABLE ROW LEVEL SECURITY;

-- Staff lê (observabilidade: eu monitoro quem segura o lease via psql-ro).
DROP POLICY IF EXISTS "fin_sync_lease_select_staff" ON public.fin_sync_lease;
CREATE POLICY "fin_sync_lease_select_staff"
  ON public.fin_sync_lease FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = auth.uid()
              AND role IN ('employee'::public.app_role, 'master'::public.app_role))
  );

-- Service role (a edge/cron) escreve. As RPCs abaixo são SECURITY DEFINER (bypassam
-- RLS internamente) + gate por REVOKE/GRANT; esta policy cobre acesso direto.
DROP POLICY IF EXISTS "fin_sync_lease_service_all" ON public.fin_sync_lease;
CREATE POLICY "fin_sync_lease_service_all"
  ON public.fin_sync_lease FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ─────────────────────────── RPCs (SQL puro, SECURITY DEFINER, search_path pinado) ───────────────────────────

-- (1) acquire: tenta tomar o lease ATOMICAMENTE. Retorna o token se conseguiu;
-- NULL se a conta já tem lease VIVO (busy). O INSERT ... ON CONFLICT DO UPDATE
-- ... WHERE l.expires_at <= now() é atômico: sob dois acquirers concorrentes, o
-- perdedor vê a linha vencedora (viva) → a WHERE bloqueia o UPDATE → RETURNING
-- vazio → NULL. Só ROUBA um lease já EXPIRADO (expires_at <= now()), gerando token
-- novo (o token velho deixa de valer → o release do dono morto vira no-op).
CREATE OR REPLACE FUNCTION public.fin_sync_lease_acquire(
  p_company text, p_holder text, p_ttl_seconds integer DEFAULT 300
) RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.fin_sync_lease AS l (company, token, holder, acquired_at, expires_at, updated_at)
  VALUES (p_company, gen_random_uuid(), p_holder, now(), now() + make_interval(secs => p_ttl_seconds), now())
  ON CONFLICT (company) DO UPDATE
     SET token       = gen_random_uuid(),
         holder      = EXCLUDED.holder,
         acquired_at = now(),
         expires_at  = now() + make_interval(secs => p_ttl_seconds),
         updated_at  = now()
   WHERE l.expires_at <= now()          -- só rouba lease EXPIRADO; lease vivo → sem UPDATE → NULL
  RETURNING token;
$$;

-- (2) release: LIBERA o lease (marca expirado) — token-guarded. Só age se o token
-- passado é o que está gravado: um dono cujo lease expirou e foi roubado (token
-- novo) NÃO libera o lease do novo dono (WHERE token=p_token não casa → no-op).
-- Retorna true se liberou (o lease ainda era meu), false se não (roubado/inexistente).
-- Marca expirado (não deleta) → preserva a última info p/ observabilidade.
CREATE OR REPLACE FUNCTION public.fin_sync_lease_release(
  p_company text, p_token uuid
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH freed AS (
    UPDATE public.fin_sync_lease
       SET expires_at = now() - interval '1 second', updated_at = now()
     WHERE company = p_company AND token = p_token
    RETURNING company
  )
  SELECT EXISTS (SELECT 1 FROM freed);
$$;

-- Gate na fronteira: só service_role (a edge) executa o state-machine do lease.
REVOKE ALL ON FUNCTION public.fin_sync_lease_acquire(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_sync_lease_release(text, uuid)            FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_sync_lease_acquire(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fin_sync_lease_release(text, uuid)          TO service_role;

-- ─────────────────────────── Status novo 'skipped_busy' no fin_sync_log ───────────────────────────
-- A CHECK atual = status IN ('running','complete','error') → gravar 'skipped_busy'
-- FALHARIA (23514). Recriar incluindo o valor (ADD-only: linhas existentes seguem
-- válidas). 'skipped_busy' = a invocação NÃO adquiriu o lease e saiu sem tocar o
-- Omie/cursor; a edge grava completed_at=NULL nesse caso → invisível p/ os
-- consumidores de frescor (_data_health_compute/fin_calcular_confiabilidade/
-- fin_sync_heartbeat filtram completed_at IS NOT NULL ou status='complete'; o
-- watchdog usa 'running'/'complete'/IN('complete','error') — nenhum casa 'skipped_busy').
ALTER TABLE public.fin_sync_log DROP CONSTRAINT IF EXISTS fin_sync_log_status_check;
ALTER TABLE public.fin_sync_log ADD CONSTRAINT fin_sync_log_status_check
  CHECK (status = ANY (ARRAY['running'::text, 'complete'::text, 'error'::text, 'skipped_busy'::text]));
