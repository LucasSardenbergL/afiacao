-- ============================================================
-- vendas_sync_semear_janela v2 (ATÔMICA) — supersede a 20260726130000 (v1,
-- por conta, NUNCA aplicada em prod — não colar a v1; este arquivo é
-- auto-suficiente e dropa a assinatura antiga por segurança).
--
-- Por que v2 (challenge Codex xhigh, achado P1): na v1 o cliente fazia DUAS
-- chamadas sequenciais (oben, colacor). Se a 2ª falhasse — ou o Chrome matasse
-- o JS entre elas, exatamente o modo de morte do incidente 2026-07-20/21 —
-- ficava janela PARCIAL (só oben) com o botão travado pela janela aberta:
-- colacor inalcançável até a oben terminar. A v2 arma TODAS as contas em UMA
-- transação: ou o par inteiro, ou nada.
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
--   • UMA chamada, MESMA transação, todas as contas (atômico);
--   • pg_advisory_xact_lock por conta em ordem determinística (2 abas semeando
--     junto não intercalam; sem risco de deadlock);
--   • recusa honesta 'ja_pendente_outra' quando a conta já tem OUTRA janela
--     aberta (o cron trabalha a mais antiga primeiro — semear por cima só
--     enfileiraria atrás dela; Codex P2);
--   • INSERT ... ON CONFLICT DO NOTHING: NUNCA toca janela existente — não
--     rebobina next_page, não rouba lease, não reabre janela completa;
--   • o clique vira mutação curta; o progresso é LEITURA (staff tem SELECT na
--     tabela via RLS) e a importação roda no servidor — pode fechar a aba.
-- ============================================================

-- Assinatura v1 (por conta) — nunca aplicada; DROP cobre qualquer apply manual acidental.
DROP FUNCTION IF EXISTS public.vendas_sync_semear_janela(text, date, date);

CREATE OR REPLACE FUNCTION public.vendas_sync_semear_janela(
  p_date_from date,
  p_date_to   date,
  p_accounts  text[] DEFAULT ARRAY['oben', 'colacor']
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_account     text;
  v_contas      jsonb := '[]'::jsonb;
  v_desfecho    text;
  v_next        integer;
  v_done        timestamptz;
  v_aberta_from date;
  v_aberta_to   date;
BEGIN
  -- Gate staff/master na fronteira (fail-closed: uid nulo NUNCA passa) —
  -- mesmo gate de public.request_customer_metrics_refresh.
  IF v_uid IS NULL
     OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(v_uid, 'master'::public.app_role),   false)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  -- Validação de janela (money-path: melhor recusar do que semear lixo).
  IF p_accounts IS NULL OR array_length(p_accounts, 1) IS NULL THEN
    RAISE EXCEPTION 'p_accounts vazio' USING ERRCODE = '22023';
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

  -- Contas em ordem determinística → advisory locks sempre na mesma ordem (anti-deadlock).
  FOR v_account IN SELECT DISTINCT a FROM unnest(p_accounts) AS a ORDER BY a
  LOOP
    IF v_account IS NULL OR v_account NOT IN ('oben', 'colacor') THEN
      RAISE EXCEPTION 'conta invalida: % (esperado oben|colacor)', COALESCE(v_account, 'NULL')
        USING ERRCODE = '22023';
    END IF;

    -- Serializa semeadores concorrentes da MESMA conta (xact-lock: solta sozinho no fim/abort).
    PERFORM pg_advisory_xact_lock(hashtext('vendas_sync_semear_' || v_account));

    SELECT c.date_from, c.date_to
      INTO v_aberta_from, v_aberta_to
      FROM public.vendas_sync_cursor c
     WHERE c.account = v_account
       AND c.completed_at IS NULL
       AND NOT (c.date_from = p_date_from AND c.date_to = p_date_to)
     ORDER BY c.date_from
     LIMIT 1;

    IF FOUND THEN
      v_desfecho := 'ja_pendente_outra';
      v_next := NULL;
      v_done := NULL;
    ELSE
      INSERT INTO public.vendas_sync_cursor (account, date_from, date_to)
      VALUES (v_account, p_date_from, p_date_to)
      ON CONFLICT (account, date_from, date_to) DO NOTHING;
      IF FOUND THEN
        v_desfecho := 'semeada';
      END IF;
      SELECT c.next_page, c.completed_at
        INTO v_next, v_done
        FROM public.vendas_sync_cursor c
       WHERE c.account = v_account AND c.date_from = p_date_from AND c.date_to = p_date_to;
      IF v_desfecho IS NULL THEN
        v_desfecho := CASE WHEN v_done IS NOT NULL THEN 'ja_concluida' ELSE 'ja_pendente' END;
      END IF;
    END IF;

    v_contas := v_contas || jsonb_build_object(
      'account',           v_account,
      'desfecho',          v_desfecho,
      'next_page',         v_next,
      'completed_at',      v_done,
      'janela_aberta_de',  v_aberta_from,
      'janela_aberta_ate', v_aberta_to
    );

    v_desfecho := NULL; v_next := NULL; v_done := NULL;
    v_aberta_from := NULL; v_aberta_to := NULL;
  END LOOP;

  RETURN jsonb_build_object('date_from', p_date_from, 'date_to', p_date_to, 'contas', v_contas);
END;
$$;

COMMENT ON FUNCTION public.vendas_sync_semear_janela(date, date, text[]) IS
  'Arma janelas de backfill de pedidos no vendas_sync_cursor (staff/master; fail-closed), '
  'TODAS as contas na mesma transação (atômico) com advisory lock por conta. ON CONFLICT DO '
  'NOTHING: nunca toca janela existente; conta com OUTRA janela aberta recebe ja_pendente_outra. '
  'O cron vendas-sync-continuacao-6min pega a pendente mais antiga por conta e o edge '
  'omie-vendas-sync importa com lease+heartbeat.';

-- Fronteira de EXECUTE: caller humano via PostgREST (o gate interno barra não-staff).
-- REVOKE nominal (default privilege do Supabase concede EXECUTE a anon/authenticated
-- em toda função nova; REVOKE FROM PUBLIC não tira o grant explícito — CLAUDE.md).
REVOKE ALL ON FUNCTION public.vendas_sync_semear_janela(date, date, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendas_sync_semear_janela(date, date, text[]) TO authenticated;
