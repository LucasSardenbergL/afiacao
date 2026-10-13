-- ============================================================
-- M-36 (plano 2026-09-05, Lote G): retenção LGPD de 90 dias para o CONTEÚDO de conversa —
-- transcrição de ligação, transcrição do copilot e corpo/mídia/transcrição de WhatsApp —, com
-- LEGAL HOLD explícito e cron diário de expurgo.
--
-- O QUE SAI (após 90 dias, salvo legal hold) — só conteúdo bruto, o REGISTRO de negócio fica:
--   farmer_calls.transcript                       → NULL (a ligação, duração, resultado e receita ficam)
--   farmer_copilot_sessions.transcript_summary    → NULL
--   farmer_copilot_events.transcript_snippet      → NULL
--   whatsapp_messages.body/transcript/media_url/media_id → NULL (direção, status e horário ficam)
--   whatsapp_webhook_events (payload cru da Meta) → DELETE, se já processado
--
-- O QUE FICA, e por quê:
--   · farmer_calls.entities_extracted / sinais_ligacao — dado DERIVADO (produto citado, sinal), não
--     transcrição; e limpar `entities_extracted` dispara `trg_farmer_calls_enqueue_recalc`, que
--     mudaria o score do cliente. Expurgo não pode mexer em dinheiro/score.
--   · farmer_calls.notes — anotação digitada pela vendedora, não gravação.
--   · farmer_copilot_events.event_data / suggestion_text — telemetria da sugestão, não a fala.
--   · ÁUDIO das gravações — não vive neste banco (só `call_log.recorded`, boolean); fica no provedor
--     SIP (Nvoip). A retenção dele é contratual/no painel do provedor, fora do alcance do SQL.
--
-- LEGAL HOLD: `legal_hold` + `legal_hold_motivo` (CHECK: hold sem motivo é recusado) em
-- farmer_calls, farmer_copilot_sessions (cobre os eventos dela) e whatsapp_conversations (cobre as
-- mensagens dela). O webhook cru não tem dono de conversa: o hold vale para a mensagem já
-- processada, que é a prova; o payload cru só sai depois de processado.
--
-- Medido em prod (psql-ro, 2026-10-12): farmer_calls 0, copilot 0/0, whatsapp_messages 0,
-- whatsapp_webhook_events 1 linha — o 1º expurgo é quase no-op; o contrato é para o descongelamento
-- (telefonia/WhatsApp estão congelados no M-41). Todas as colunas zeradas são NULLABLE (conferido).
-- Aplicar pelo `bun run db:aplicar` (o executor dá a transação; este arquivo não leva BEGIN/COMMIT).
-- ============================================================

-- ------------------------------------------------------------
-- 1) Legal hold — coluna + motivo obrigatório
-- ------------------------------------------------------------
ALTER TABLE public.farmer_calls            ADD COLUMN IF NOT EXISTS legal_hold boolean NOT NULL DEFAULT false;
ALTER TABLE public.farmer_calls            ADD COLUMN IF NOT EXISTS legal_hold_motivo text;
ALTER TABLE public.farmer_copilot_sessions ADD COLUMN IF NOT EXISTS legal_hold boolean NOT NULL DEFAULT false;
ALTER TABLE public.farmer_copilot_sessions ADD COLUMN IF NOT EXISTS legal_hold_motivo text;
ALTER TABLE public.whatsapp_conversations  ADD COLUMN IF NOT EXISTS legal_hold boolean NOT NULL DEFAULT false;
ALTER TABLE public.whatsapp_conversations  ADD COLUMN IF NOT EXISTS legal_hold_motivo text;

DO $$
DECLARE
  v_tab text;
BEGIN
  FOREACH v_tab IN ARRAY ARRAY['farmer_calls', 'farmer_copilot_sessions', 'whatsapp_conversations'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = format('public.%I', v_tab)::regclass
         AND conname = v_tab || '_legal_hold_motivo_chk'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (NOT legal_hold OR nullif(btrim(legal_hold_motivo), %L) IS NOT NULL)',
        v_tab, v_tab || '_legal_hold_motivo_chk', ''
      );
    END IF;
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 2) Função de expurgo — piso de 90 dias (LGPD é o teto do que se GUARDA, não o mínimo)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.expurgar_conteudo_conversas(p_dias int DEFAULT 90)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_corte timestamptz;
  v_calls bigint;
  v_sessoes bigint;
  v_eventos bigint;
  v_msgs bigint;
  v_webhook bigint;
BEGIN
  IF p_dias IS NULL OR p_dias < 90 THEN
    RAISE EXCEPTION 'retencao_minima: p_dias=% < 90', p_dias USING ERRCODE = '22023';
  END IF;
  v_corte := now() - make_interval(days => p_dias);

  UPDATE public.farmer_calls
     SET transcript = NULL
   WHERE created_at < v_corte AND NOT legal_hold AND transcript IS NOT NULL;
  GET DIAGNOSTICS v_calls = ROW_COUNT;

  UPDATE public.farmer_copilot_sessions
     SET transcript_summary = NULL
   WHERE started_at < v_corte AND NOT legal_hold AND transcript_summary IS NOT NULL;
  GET DIAGNOSTICS v_sessoes = ROW_COUNT;

  UPDATE public.farmer_copilot_events e
     SET transcript_snippet = NULL
   WHERE e.created_at < v_corte AND e.transcript_snippet IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.farmer_copilot_sessions s WHERE s.id = e.session_id AND s.legal_hold);
  GET DIAGNOSTICS v_eventos = ROW_COUNT;

  UPDATE public.whatsapp_messages m
     SET body = NULL, transcript = NULL, media_url = NULL, media_id = NULL
   WHERE m.created_at < v_corte
     AND (m.body IS NOT NULL OR m.transcript IS NOT NULL OR m.media_url IS NOT NULL OR m.media_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.whatsapp_conversations c WHERE c.id = m.conversation_id AND c.legal_hold);
  GET DIAGNOSTICS v_msgs = ROW_COUNT;

  DELETE FROM public.whatsapp_webhook_events
   WHERE received_at < v_corte AND processed_at IS NOT NULL;
  GET DIAGNOSTICS v_webhook = ROW_COUNT;

  RETURN jsonb_build_object(
    'corte', v_corte,
    'farmer_calls_transcript', v_calls,
    'copilot_sessions_summary', v_sessoes,
    'copilot_events_snippet', v_eventos,
    'whatsapp_messages_conteudo', v_msgs,
    'whatsapp_webhook_events_apagados', v_webhook
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.expurgar_conteudo_conversas(int) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3) Cron diário — 04:40 UTC, fora do 04:00 (purge-cron), 04:20 (analytics) e 04:30 (scores)
-- ------------------------------------------------------------
SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname = 'lgpd-expurgo-conversas-diario';
SELECT cron.schedule(
  'lgpd-expurgo-conversas-diario',
  '40 4 * * *',
  $cron$SELECT private.expurgar_conteudo_conversas(90);$cron$
);

-- ------------------------------------------------------------
-- Postcondição — colunas, CHECKs, ACL da função e o job; aborta tudo se algo não pegou
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_cols int;
  v_chk  int;
  v_job  int;
BEGIN
  SELECT count(*) INTO v_cols FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('farmer_calls', 'farmer_copilot_sessions', 'whatsapp_conversations')
     AND column_name IN ('legal_hold', 'legal_hold_motivo');
  SELECT count(*) INTO v_chk FROM pg_constraint
   WHERE conname IN ('farmer_calls_legal_hold_motivo_chk', 'farmer_copilot_sessions_legal_hold_motivo_chk',
                     'whatsapp_conversations_legal_hold_motivo_chk');
  SELECT count(*) INTO v_job FROM cron.job
   WHERE jobname = 'lgpd-expurgo-conversas-diario' AND schedule = '40 4 * * *' AND active
     AND command LIKE '%private.expurgar_conteudo_conversas(90)%';
  IF v_cols <> 6 OR v_chk <> 3 OR v_job <> 1
     OR has_function_privilege('anon', 'private.expurgar_conteudo_conversas(int)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.expurgar_conteudo_conversas(int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M36_POS_FALHOU cols=% chk=% job=%', v_cols, v_chk, v_job;
  END IF;
END
$post$;

-- Postcondição EXECUTANDO (PL/pgSQL é late-bound: CREATE passa e a função só quebra em runtime).
-- Roda o expurgo de verdade — é o mesmo que o cron faz toda madrugada — e prova os dois guardas.
DO $exec$
DECLARE
  v_res jsonb;
BEGIN
  v_res := private.expurgar_conteudo_conversas(90);
  IF NOT (v_res ? 'corte' AND v_res ? 'whatsapp_messages_conteudo') THEN
    RAISE EXCEPTION 'M36_EXEC_FALHOU retorno=%', v_res;
  END IF;
  RAISE NOTICE 'M36 expurgo inicial: %', v_res;

  BEGIN
    PERFORM private.expurgar_conteudo_conversas(30);
    RAISE EXCEPTION 'M36_PISO_FALHOU: p_dias=30 foi aceito';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  BEGIN
    UPDATE public.whatsapp_conversations SET legal_hold = true, legal_hold_motivo = '  '
     WHERE id = (SELECT id FROM public.whatsapp_conversations LIMIT 1);
    IF FOUND THEN
      RAISE EXCEPTION 'M36_CHECK_FALHOU: legal_hold sem motivo foi aceito';
    END IF;
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$exec$;
