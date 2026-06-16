-- ============================================================
-- Watchdog do sync Omie — iteração 3: regra sync_error "tail-failing"
-- ============================================================
-- Dor confirmada por diagnóstico (2026-05-28): colacor/sync_movimentacoes gerou
-- ~12 erros em 16h (~18%), TODOS 'SOAP-ERROR: Broken response from Application
-- Server (BG)' — instabilidade UPSTREAM do Omie, não timeout (durações 15-86s,
-- longe do TIME_BUDGET de 100s; completes interspersos; último complete OK 19:40;
-- sync cursor-based se auto-cura, sem perda de dado). A regra antiga (iteração 1/2)
--   sync_error = "QUALQUER fin_sync_log status='error' nas últimas 6h"
-- com upstream flaky ~18% → SEMPRE existe >=1 erro na janela de 6h → o alerta
-- 'critico' fica PERMANENTEMENTE aceso e nunca dismissa → fadiga de alerta (um
-- crítico sempre ligado deixa de ser sinal — oposto do que o Sentinela deveria fazer).
--
-- Mesmo espírito da lição já registrada na §5 ("staleness por tempo-desde-complete
-- é não-confiável; o sinal confiável é o 'running' travado"): a regra precisa
-- distinguir "flaky mas PROGREDINDO" de "realmente PARADO".
--
-- Fix (codex-validado): sync_error vira "TAIL-FAILING" — só alerta quando, para um
-- par (company, action), a run terminal MAIS RECENTE é 'error', dentro de 3h, com
-- >=2 erros consecutivos (sem 'complete' entre eles, nem depois). Só 'complete'
-- resolve ('running' nunca conta como recuperação). Auto-dismissa no instante em que
-- um 'complete' cai depois. Bound de 3h + >=2 consecutivos de-noisa o flap do Omie
-- sem perder detecção de outage real (que produz erros consecutivos ou cruza os
-- backstops). Backstops pra falha persistente PRESERVADOS: sync_stale (>18h sem
-- complete) e sync_cursor_stuck (>2h). Trade-off consciente: uma órfã ISOLADA (1 só
-- erro) deixa de paginar na hora — mas a varredura de órfãs (seção 0) + o */10 fazem
-- a falha recorrer em >=2 rapidamente, e sync_stale/cursor cobrem o caso raro de
-- órfã única sem retry. Granularidade preservada: 1 alerta por empresa (tipo
-- 'sync_error', UNIQUE (company,tipo) intacta), com as actions falhando em
-- contexto.actions — o heartbeat conta por tipo, inalterado.
--
-- CREATE OR REPLACE de UMA função; sem objeto novo, sem mudar cron (fin-sync-watchdog
-- já chama esta função por nome). Seções 0/1/3 e o heartbeat inalterados.

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
  --    Marca 'error'; o sinal sync_error abaixo paginará se o rabo do par estiver
  --    falhando (run mais recente em erro, >=2 consecutivos).
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

    -- 2) ERRO EXPLÍCITO (refinado — TAIL-FAILING): só alerta quando o RABO do par
    --    (company, action) está falhando AGORA — a run terminal mais recente é
    --    'error', dentro de 3h, com >=2 erros consecutivos (sem 'complete' entre eles
    --    nem depois). Só 'complete' resolve; 'running' não conta como recuperação.
    --    Substitui "qualquer erro em 6h" (ficava permanentemente acesa c/ Omie flaky).
    --    1 alerta por empresa (tipo 'sync_error'), actions falhando em contexto.actions.
    WITH terminal AS (
      SELECT l.action, l.status, l.started_at
      FROM fin_sync_log l
      WHERE l.action LIKE 'sync_%'
        AND c = ANY(l.companies)
        AND l.status IN ('complete','error')
        AND l.started_at > now() - interval '24 hours'
    ),
    latest AS (
      SELECT DISTINCT ON (action) action, status, started_at
      FROM terminal
      ORDER BY action, started_at DESC
    )
    SELECT array_agg(lt.action ORDER BY lt.action) INTO v_errs
    FROM latest lt
    WHERE lt.status = 'error'
      AND lt.started_at > now() - interval '3 hours'
      AND (
        SELECT count(*) FROM terminal t
        WHERE t.action = lt.action
          AND t.status = 'error'
          AND t.started_at <= lt.started_at
          AND NOT EXISTS (
            SELECT 1 FROM terminal cpl
            WHERE cpl.action = lt.action
              AND cpl.status = 'complete'
              AND cpl.started_at > t.started_at
              AND cpl.started_at <= lt.started_at
          )
      ) >= 2;
    IF v_errs IS NOT NULL THEN
      v_msg := 'Sync falhando agora (run mais recente em erro, >=2 consecutivos): '||array_to_string(v_errs, ', ');
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
