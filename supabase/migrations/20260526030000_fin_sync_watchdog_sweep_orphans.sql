-- ============================================================
-- Watchdog do sync Omie — iteração 2: varredura de passes órfãs
-- ============================================================
-- Dor confirmada por diagnóstico (2026-05-25): 25 linhas fin_sync_log em
-- status='running' nunca finalizadas (de 6,6h a 57 dias). 17 criadas só hoje,
-- com 0 'error' no período → o bug "catch do omie-financeiro não chama
-- completeSync" (+ kills WORKER_RESOURCE_LIMIT/timeout que nem passam pelo catch)
-- vinha DERROTANDO o próprio watchdog: nada virava 'error', então o sinal
-- sync_error (iteração 1) nunca disparava. Falha silenciosa clássica.
--
-- Premissa de cadência VALIDADA com dados: teto de duração legítima medido = 133s
-- (sync_all 133 / CR 132 / mov 131 / CP 111; resto ≤14s). Um 'running' > 30min é
-- 13,5× o teto → inequivocamente morto. Diferente de staleness (rajada → não
-- confiável), o 'running' travado é sinal inequívoco de detecção rápida.
--
-- Decisão (codex-validada): VARRER e ALERTAR pela fonte canônica única.
-- A varredura marca a órfã como 'error' (msg 'orphaned_running_timeout'); o sinal
-- sync_error que JÁ existe (iteração 1) alerta de graça → sem tipo 'sync_orphan'
-- novo, sem dupla-contagem. Estreito/idempotente/auditável: só toca
-- status='running' AND action LIKE 'sync_%' AND started_at < now()-30min.
--
-- Refino sobre o dado: completed_at = now() só p/ órfã < v_error_hours (alerta
-- fresca); backlog mais antigo preserva started_at → fica FORA da janela do sinal
-- sync_error e é limpo SILENCIOSAMENTE (sem blast de email sobre lixo de 57 dias).
-- Resolve backlog + futuro num deploy só, idempotente (status='error' não re-varre).
--
-- CREATE OR REPLACE de UMA função; sem objeto novo, sem mudar cron (fin-sync-watchdog
-- já chama esta função por nome). Heartbeat inalterado.

CREATE OR REPLACE FUNCTION public.fin_sync_watchdog_check()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_companies text[] := ARRAY['oben','colacor','colacor_sc'];
  v_resources text[] := ARRAY['contas_pagar','contas_receber','movimentacoes'];
  v_stale_hours  int := 18;
  v_error_hours  int := 6;
  v_cursor_hours int := 2;
  c text;
  v_stale text[];
  v_errs  text[];
  v_stuck text[];
  v_msg text;
BEGIN
  -- 0) VARREDURA DE ÓRFÃS: pass 'running' que nunca finalizou (ver cabeçalho).
  --    Marca 'error' → o sinal sync_error abaixo alerta na mesma tick.
  UPDATE fin_sync_log
  SET status        = 'error',
      error_message = 'orphaned_running_timeout',
      completed_at  = CASE WHEN started_at > now() - make_interval(hours => v_error_hours)
                           THEN now() ELSE started_at END
  WHERE status = 'running'
    AND action LIKE 'sync_%'
    AND started_at < now() - interval '30 minutes';

  FOREACH c IN ARRAY v_companies LOOP
    -- 1) FRESCOR: par ATIVO (complete em 7d) sem complete na janela
    SELECT array_agg(r ORDER BY r) INTO v_stale
    FROM unnest(v_resources) AS r
    WHERE EXISTS (
      SELECT 1 FROM fin_sync_log l
      WHERE l.status='complete' AND l.action='sync_'||r AND c = ANY(l.companies)
        AND l.completed_at > now() - interval '7 days')
      AND NOT EXISTS (
      SELECT 1 FROM fin_sync_log l
      WHERE l.status='complete' AND l.action='sync_'||r AND c = ANY(l.companies)
        AND l.completed_at > now() - make_interval(hours => v_stale_hours));
    IF v_stale IS NOT NULL THEN
      v_msg := 'Sync sem conclusão há >'||v_stale_hours||'h: '||array_to_string(v_stale, ', ');
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c, 'sync_stale', 'critico', v_msg,
              jsonb_build_object('recursos', v_stale, 'janela_horas', v_stale_hours))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'urgente', '[Sync parado] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_stale' AND dismissed_at IS NULL;
    END IF;

    -- 2) ERRO EXPLÍCITO: fin_sync_log status='error' recente (inclui órfãs varridas acima)
    SELECT array_agg(DISTINCT l.action ORDER BY l.action) INTO v_errs
    FROM fin_sync_log l
    WHERE l.status='error' AND c = ANY(l.companies) AND l.action LIKE 'sync_%'
      AND COALESCE(l.completed_at, l.started_at) > now() - make_interval(hours => v_error_hours);
    IF v_errs IS NOT NULL THEN
      v_msg := 'Sync com erro nas últimas '||v_error_hours||'h: '||array_to_string(v_errs, ', ');
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c, 'sync_error', 'critico', v_msg, jsonb_build_object('actions', v_errs))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'urgente', '[Sync erro] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_error' AND dismissed_at IS NULL;
    END IF;

    -- 3) CURSOR TRAVADO: next_page pendente velho
    SELECT array_agg(resource ORDER BY resource) INTO v_stuck
    FROM fin_sync_cursor
    WHERE company = c AND next_page IS NOT NULL
      AND updated_at < now() - make_interval(hours => v_cursor_hours);
    IF v_stuck IS NOT NULL THEN
      v_msg := 'Cursor de continuação travado há >'||v_cursor_hours||'h: '||array_to_string(v_stuck, ', ');
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c, 'sync_cursor_stuck', 'aviso', v_msg, jsonb_build_object('recursos', v_stuck))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'atencao', '[Sync cursor] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_cursor_stuck' AND dismissed_at IS NULL;
    END IF;
  END LOOP;
END;
$$;
