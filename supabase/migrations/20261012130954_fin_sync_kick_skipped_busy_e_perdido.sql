-- ============================================================================
-- fin_sync_kicks_perdidos — `skipped_busy` NÃO conta como "o kick chegou"
-- ============================================================================
-- Incidente (medido em prod via psql-ro, 2026-10-12): colacor/movimentacoes
-- ficou parado de 11/10 16:20 até a janela seguinte. O cron fin-sync-mov-2x (:40)
-- caiu em cima do último chunk do contas_receber da colacor (05:40:02→05:41:40),
-- o lease da conta estava ocupado e a invocação saiu `skipped_busy` às 05:40:03
-- sem tocar Omie nem cursor. O retry (20260704102000) existe para esse caso, mas
-- o guard (a) tratava QUALQUER linha pós-janela como "kick chegou" — inclusive a
-- skipped_busy — então fin_sync_kick_retry ficou sem tentativa e o recurso esperou
-- 6h. Recorrente: skipped_busy da colacor em todos os dias de 08/10 a 12/10.
--
-- Mudança (1 predicado): o guard (a) ignora status='skipped_busy'. Todo o resto
-- fica idêntico ao corpo VIVO de prod (pg_get_functiondef em 2026-10-12):
--   • error/running/complete continuam bloqueando (decisão 6 de 20260704102000:
--     error não é re-chutado às cegas);
--   • guard (d) (running <10min da empresa) segue segurando o retry enquanto a
--     conta está ocupada → o retry sai no 1º tick com a conta livre;
--   • guard (c) segue em 1 retry por janela — sem laço.
-- CREATE OR REPLACE preserva o ACL (REVOKE de PUBLIC/anon/authenticated de prod).
-- Prova: db/test-fin-sync-kick-skipped-busy.sh
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.fin_sync_kicks_perdidos(p_now timestamp with time zone DEFAULT now())
 RETURNS TABLE(company text, resource text, janela timestamp with time zone, prio integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    -- (a) nenhum sinal no log pós-janela (qualquer status = kick chegou), EXCETO
    --     skipped_busy: essa invocação não pegou o lease e saiu sem sincronizar
    --     nada — o kick se perdeu do mesmo jeito (2026-10-12).
    NOT EXISTS (
      SELECT 1 FROM public.fin_sync_log l
      WHERE l.action = 'sync_' || u.resource
        AND e.company = ANY (l.companies)
        AND l.started_at >= u.janela
        AND l.status IS DISTINCT FROM 'skipped_busy'
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
$function$;

-- Postcondição: o corpo novo pegou E o fechamento de ACL sobreviveu.
DO $post$
DECLARE
  v_fn regprocedure := to_regprocedure('public.fin_sync_kicks_perdidos(timestamp with time zone)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'postcondição: fin_sync_kicks_perdidos(timestamptz) não existe';
  END IF;
  IF position('IS DISTINCT FROM ''skipped_busy''' IN pg_get_functiondef(v_fn)) = 0 THEN
    RAISE EXCEPTION 'postcondição: guard (a) sem a exclusão de skipped_busy';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondição: anon executa fin_sync_kicks_perdidos (ACL aberto)';
  END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondição: service_role perdeu EXECUTE em fin_sync_kicks_perdidos';
  END IF;
  RAISE NOTICE 'fin_sync_kicks_perdidos: skipped_busy agora é kick perdido ✅';
END
$post$;

COMMIT;
