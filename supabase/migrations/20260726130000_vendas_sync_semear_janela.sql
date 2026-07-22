-- ============================================================
-- vendas_sync_semear_janela — caminho de ESCRITA gateado (staff) pra armar o
-- backfill de pedidos no motor server-side (vendas_sync_cursor + cron */6).
--
-- Contexto (incidente 2026-07-20/21, follow-up dos PRs #1500/#1502): o botão
-- "Importar Recentes (180d)" rodava um loop client-side de 40-60 min invocando
-- omie-vendas-sync ~26-35x por conta — o Chrome matava o JS ~12 min depois do
-- clique (aba em background/Memory Saver) e deixava órfãos 'executando' em
-- acoes_execucoes. O motor server-side JÁ EXISTE (20260617133633: cursor + lease
-- + cron vendas-sync-continuacao-6min); faltava um caminho de escrita pro staff
-- SEMEAR a janela sem colar INSERT no SQL Editor. Esta RPC é esse caminho:
--   • SECURITY DEFINER (a escrita na tabela é service_role-only via RLS);
--   • gate staff/master na FRONTEIRA, fail-closed (espelho verbatim do gate de
--     request_customer_metrics_refresh — forma bloqueante do authz-gate-check);
--   • INSERT ... ON CONFLICT DO NOTHING: NUNCA toca janela existente — não
--     rebobina next_page, não rouba lease, não reabre janela completa;
--   • o clique vira mutação curta; o progresso é LEITURA (staff tem SELECT na
--     tabela via RLS) e a importação roda no servidor — pode fechar a aba.
-- ============================================================

CREATE OR REPLACE FUNCTION public.vendas_sync_semear_janela(
  p_account   text,
  p_date_from date,
  p_date_to   date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_semeada      boolean := false;
  v_next_page    integer;
  v_completed_at timestamptz;
BEGIN
  -- Gate staff/master na fronteira (fail-closed: uid nulo NUNCA passa) —
  -- mesmo gate de public.request_customer_metrics_refresh.
  IF v_uid IS NULL
     OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(v_uid, 'master'::public.app_role),   false)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  -- Validação de janela (money-path: melhor recusar do que semear lixo).
  IF p_account IS NULL OR p_account NOT IN ('oben', 'colacor') THEN
    RAISE EXCEPTION 'conta invalida: % (esperado oben|colacor)', COALESCE(p_account, 'NULL')
      USING ERRCODE = '22023';
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_from > p_date_to THEN
    RAISE EXCEPTION 'janela invalida: date_from (%) deve ser <= date_to (%)', p_date_from, p_date_to
      USING ERRCODE = '22023';
  END IF;
  IF p_date_to > current_date THEN
    RAISE EXCEPTION 'janela invalida: date_to (%) no futuro', p_date_to
      USING ERRCODE = '22023';
  END IF;
  IF p_date_from < DATE '2015-01-01' THEN
    RAISE EXCEPTION 'janela invalida: date_from (%) anterior a 2015-01-01', p_date_from
      USING ERRCODE = '22023';
  END IF;

  -- Semeadura idempotente: janela nova nasce livre (next_page NULL → lease_acquire
  -- retoma da pág 1); janela EXISTENTE (pendente, em voo ou completa) fica intocada.
  INSERT INTO public.vendas_sync_cursor (account, date_from, date_to)
  VALUES (p_account, p_date_from, p_date_to)
  ON CONFLICT (account, date_from, date_to) DO NOTHING;
  v_semeada := FOUND;

  SELECT c.next_page, c.completed_at
    INTO v_next_page, v_completed_at
    FROM public.vendas_sync_cursor c
   WHERE c.account = p_account AND c.date_from = p_date_from AND c.date_to = p_date_to;

  RETURN jsonb_build_object(
    'semeada',      v_semeada,
    'account',      p_account,
    'date_from',    p_date_from,
    'date_to',      p_date_to,
    'next_page',    v_next_page,
    'completed_at', v_completed_at
  );
END;
$$;

COMMENT ON FUNCTION public.vendas_sync_semear_janela(text, date, date) IS
  'Arma uma janela de backfill de pedidos no vendas_sync_cursor (staff/master; fail-closed). '
  'ON CONFLICT DO NOTHING: nunca toca janela existente. O cron vendas-sync-continuacao-6min '
  'pega a janela pendente mais antiga por conta e o edge omie-vendas-sync importa com lease+heartbeat.';

-- Fronteira de EXECUTE: caller humano via PostgREST (o gate interno barra não-staff).
-- REVOKE nominal (default privilege do Supabase concede EXECUTE a anon/authenticated
-- em toda função nova; REVOKE FROM PUBLIC não tira o grant explícito — CLAUDE.md).
REVOKE ALL ON FUNCTION public.vendas_sync_semear_janela(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendas_sync_semear_janela(text, date, date) TO authenticated;
