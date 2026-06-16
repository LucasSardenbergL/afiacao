-- ============================================================
-- Watchdog de integridade do sync Omie (iteração 1)
-- ============================================================
-- Spec/plano: docs/superpowers/{specs,plans}/2026-05-25-omie-sync-watchdog*.
-- Dor (CLAUDE.md §5): CRON_SECRET divergiu → ~20 crons 401 SILENCIOSO; job_run_details
-- dizia "succeeded"; founder descobriu por reclamação dias depois.
--
-- 2 funções SECURITY DEFINER + 2 crons (SQL puro, sem edge function nova, sem secret).
-- Premissas confirmadas em prod (Task 1):
--   - fin_sync_log loga per-company com a empresa em companies[] (predicado = ANY(companies) ok).
--   - dispatch-notifications drena fornecedor_alerta SÓ por status='pendente_notificacao'
--     (não por empresa) → enfileiro com a empresa real e o email é enviado.
-- Refino vs spec: staleness só p/ par ATIVO (synced em 7d) que ficou stale (evita
--   falso-positivo de par dormente e cadências diferentes). net._http_response → iteração 1.5.

-- ------------------------------------------------------------
-- 1) Watchdog: cruza sinais e grava/dismiss em fin_alertas; enfileira email na transição.
-- ------------------------------------------------------------
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

    -- 2) ERRO EXPLÍCITO: fin_sync_log status='error' recente
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

-- ------------------------------------------------------------
-- 2) Heartbeat: resumo diário (dead-man-switch).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_sync_heartbeat()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_resumo text;
  v_ativos int;
BEGIN
  SELECT count(*) INTO v_ativos
  FROM fin_alertas WHERE tipo LIKE 'sync_%' AND dismissed_at IS NULL;

  SELECT string_agg(linha, E'\n' ORDER BY linha) INTO v_resumo
  FROM (
    SELECT format('%s/%s: %s', co, re, COALESCE(to_char(m.mx, 'DD/MM HH24:MI'), 'NUNCA')) AS linha
    FROM unnest(ARRAY['oben','colacor','colacor_sc']) AS co
    CROSS JOIN unnest(ARRAY['contas_pagar','contas_receber','movimentacoes']) AS re
    CROSS JOIN LATERAL (
      SELECT max(l.completed_at) AS mx FROM fin_sync_log l
      WHERE l.status='complete' AND l.action='sync_'||re AND co = ANY(l.companies)
    ) m
  ) s;

  INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
  VALUES ('oben', 'outro', 'info',
          '[Watchdog OK] '||to_char(now(),'DD/MM'),
          'Watchdog do sync rodou. Alertas de sync ativos: '||v_ativos||
          E'.\n\nÚltimo sync OK por empresa/recurso:\n'||COALESCE(v_resumo,'(sem dados)'),
          'pendente_notificacao');
END;
$$;

-- ------------------------------------------------------------
-- 3) Crons (upsert por nome → idempotente). Rodam como postgres (dono das funções).
-- ------------------------------------------------------------
SELECT cron.schedule('fin-sync-watchdog', '*/30 * * * *',
  $$SELECT public.fin_sync_watchdog_check()$$);
SELECT cron.schedule('fin-sync-heartbeat', '0 11 * * 1-5',
  $$SELECT public.fin_sync_heartbeat()$$);
