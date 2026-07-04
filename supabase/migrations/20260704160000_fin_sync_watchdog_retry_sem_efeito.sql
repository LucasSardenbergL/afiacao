-- ============================================================================================
-- Migration — Sentinela: check "retry sem efeito" no fin_sync_watchdog_check
-- (2026-07-04 · follow-up do retry de kick perdido do fin-sync, migration 20260704102000)
-- ============================================================================================
-- CONTEXTO: a 20260704102000 (fin_sync_tick FASE 2) passou a re-postar o kick da última janela
-- esperada quando ele morre no transporte (503 BOOT_ERROR: net.http_post enfileira, a edge nunca
-- boota, zero linha em fin_sync_log). Cada retry é registrado em public.fin_sync_kick_retry
-- (company, resource, janela, attempted_at, request_id). Anti-tempestade by design: 1 retry por
-- (company, resource, janela) — se o RETRY também morrer no transporte, NÃO há novo retry na mesma
-- janela, e o buraco só apareceria no sync_stale de 18h (tarde demais).
--
-- FIX: novo bloco no fin_sync_watchdog_check (cron */30) — "retry sem efeito": um retry com
-- attempted_at > N min atrás E SEM sinal correspondente em fin_sync_log (action='sync_'||resource,
-- company = ANY(companies), started_at >= attempted_at) ⇒ o retry também morreu ⇒ alerta AVISO.
-- Fecha a janela dos 18h: detecta em ~15-45min, dando horas de antecedência ao operador antes do
-- próximo kick automático (janela seguinte, +6h).
--
-- N = 15min (v_retry_dead_mins): um retry que BOOTA loga 'running' em segundos (o 'running' é
-- escrito no início do handler, independe do timeout de 150s do sync). 15min zera falso-positivo
-- por atraso de boot/pg_net com folga generosa (precisão > recall — na dúvida, NÃO alertar).
--
-- SEVERIDADE aviso (não critico): é um alerta PRECOCE/preventivo — o sync_stale (critico, 18h)
-- segue como a rede final. tipo DEDICADO 'sync_retry_sem_efeito': o ON CONFLICT (company,tipo) do
-- watchdog silencia a 2ª classe de violação no MESMO tipo (lição docs/agent/sync.md §Sentinela) —
-- classe/remédio distintos ⇒ tipo distinto. Como começa com 'sync_', o fin_sync_heartbeat já o
-- inclui no e-mail de watchdog (tipo LIKE 'sync_%') sem tocar o heartbeat.
--
-- ⚠️ GUARD DE ORDEM (to_regclass, DENTRO da função): fin_sync_kick_retry é criada por OUTRA
-- migration (20260704102000). O apply é MANUAL (SQL Editor) e a ordem é incerta. Se ESTA rodar
-- ANTES da 20260704102000, uma referência CRUA à tabela abortaria o watchdog INTEIRO a cada tick
-- */30 (plpgsql é late-bound: o CREATE passa, o SELECT falha em runtime). O to_regclass pula o
-- bloco enquanto a tabela não existe e o check ATIVA sozinho quando ela passa a existir — o
-- Sentinela NUNCA quebra. Ordem CORRETA de apply mesmo assim: 20260704102000 primeiro (ver handoff).
--
-- ⚠️ GUARD ANTI-DRIFT + ANTI-ROLLBACK (md5 + marca VERSIONADA, na transação): gerada do
-- pg_get_functiondef VIVO de prod em 2026-07-04 (md5 7d0eccbd0a9764476da50b0952a2f9e3).
-- fin_sync_watchdog_check é QUENTE multi-sessão; o guard só recria se o corpo vivo for a base
-- esperada (md5) OU já for esta versão (marca 'retry_sem_efeito guard v1'); senão ABORTA (rebasear).
-- A marca é um COMENTÁRIO VERSIONADO dedicado (não o tipo funcional 'sync_retry_sem_efeito', que
-- uma sucessora herdaria) — assim uma migration SUCESSORA que recrie a função e troque o marcador
-- (v2, v3…) NÃO é reconhecida como "minha versão", e um re-run desta migration ABORTA em vez de
-- reverter a sucessora silenciosamente (achado Codex [P1] 2026-07-04; database.md §2 "última vence").
-- Idempotente: re-rodar ESTA por cima dela mesma é no-op seguro. Regra: nova versão MUDA o marcador.
--
-- Escopo MÍNIMO (regra multi-sessão): só fin_sync_watchdog_check é recriado. _data_health_compute,
-- data_health_watchdog e fin_sync_heartbeat (o trio acoplado por _data_health_compute) ficam
-- INTACTOS — este check é autocontido no fin_sync_watchdog_check e não passa por eles.
--
-- Achados do Codex challenge (2026-07-04), respostas:
--  [P1] rollback do guard → resolvido: marca versionada dedicada (acima), provado em db/test G1/G2.
--  [P2] started_at nullable → o writer real (omie-financeiro logSync) SEMPRE seta started_at no
--       INSERT 'running'; um started_at NULL geraria alerta CONSERVADOR (a mais), nunca silêncio.
--  [P2] sem grace de e-mail (N=15min) → consistente com sync_cursor_stuck (aviso, e-mail imediato);
--       um atraso de log >15min é ele mesmo degradação de pg_net/plataforma que MERECE o aviso; e o
--       alerta é 'aviso' e auto-dismissa quando o sinal aparece. Trade-off aceito.
--  [P2] alerta preso / array não re-emite (ON CONFLICT DO NOTHING) → idêntico a sync_stale/cursor;
--       o sync_stale (critico, 18h) é a rede final que pega o que este aviso agregou tarde.
--  [P2] to_regclass só prova existência, não schema → cobre o cenário REAL (ordem de apply); tabela
--       com schema divergente exige erro humano deliberado, fora do escopo deste guard.
--
-- PROVA PG17 (falsificada): db/test-fin-sync-watchdog-retry-sem-efeito.sh
-- ============================================================================================

BEGIN;

DO $guard$
DECLARE
  v_def text;
  v_md5 text;
BEGIN
  v_def := pg_get_functiondef('public.fin_sync_watchdog_check()'::regprocedure);
  v_md5 := md5(v_def);
  IF v_md5 <> '7d0eccbd0a9764476da50b0952a2f9e3' AND v_def NOT LIKE '%retry_sem_efeito guard v1%' THEN
    RAISE EXCEPTION USING message =
      'PRE-FLIGHT ABORTOU: fin_sync_watchdog_check vivo (md5 ' || v_md5 || ') não é a base esperada '
      || '(dump 2026-07-04, md5 7d0eccbd0a9764476da50b0952a2f9e3) nem contém o marcador '
      || '''retry_sem_efeito guard v1''. Outra migration recriou a função depois que esta foi gerada '
      || '(se for uma SUCESSORA legítima, é ela que deve rodar — NÃO re-aplique esta). '
      || 'Rebasear sobre pg_get_functiondef atual (rito docs/agent/sync.md §Sentinela) e re-gerar.';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fin_sync_watchdog_check()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_companies text[] := ARRAY['oben','colacor','colacor_sc'];
  v_resources text[] := ARRAY['contas_pagar','contas_receber','movimentacoes'];
  v_stale_hours  int := 18;
  v_error_hours  int := 6;
  v_cursor_hours int := 2;
  v_grace_mins   int := 40;
  v_retry_dead_mins int := 15;
  c text;
  v_stale text[];
  v_errs  text[];
  v_stuck text[];
  v_retry_dead text[];
  v_msg text;
BEGIN
  UPDATE fin_sync_log
  SET status        = 'error',
      error_message = 'orphaned_running_timeout',
      completed_at  = CASE WHEN started_at > now() - make_interval(hours => v_error_hours)
                           THEN now() ELSE started_at END
  WHERE status = 'running'
    AND action LIKE 'sync_%'
    AND started_at < now() - interval '30 minutes';

  FOREACH c IN ARRAY v_companies LOOP
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
      UPDATE fin_alertas
      SET email_enfileirado_em = now()
      WHERE company = c AND tipo = 'sync_stale'
        AND dismissed_at IS NULL
        AND email_enfileirado_em IS NULL
        AND criado_em <= now() - make_interval(mins => v_grace_mins);
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'urgente', '[Sync parado] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_stale' AND dismissed_at IS NULL;
    END IF;

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

    -- ── retry sem efeito ─────────────────────────────────────────────────────────
    -- retry_sem_efeito guard v1 (mig 20260704160000) — MARCADOR do guard anti-rollback
    -- do topo: uma versão SUCESSORA que recrie esta função DEVE trocar este marcador
    -- (v2, v3…). Casa por ELE, não pelo tipo 'sync_retry_sem_efeito' (que a sucessora
    -- herdaria) — assim re-aplicar esta migration sobre uma sucessora ABORTA (Codex [P1]).
    -- Um retry de kick perdido (fin_sync_kick_retry, escrito por fin_sync_tick FASE 2)
    -- foi disparado mas NÃO produziu sinal em fin_sync_log pós-attempted_at ⇒ o retry
    -- também morreu no transporte. Anti-tempestade não re-dispara na mesma janela ⇒ sem
    -- este check o buraco só apareceria no sync_stale de 18h.
    -- to_regclass: a tabela vem de OUTRA migration (20260704102000); se esta rodar ANTES
    -- (apply manual, ordem incerta), o bloco é pulado e o watchdog não quebra (late-bound).
    IF to_regclass('public.fin_sync_kick_retry') IS NOT NULL THEN
      SELECT array_agg(DISTINCT rk.resource ORDER BY rk.resource) INTO v_retry_dead
      FROM fin_sync_kick_retry rk
      WHERE rk.company = c
        AND rk.attempted_at < now() - make_interval(mins => v_retry_dead_mins)
        AND NOT EXISTS (
          SELECT 1 FROM fin_sync_log l
          WHERE l.action = 'sync_' || rk.resource
            AND c = ANY(l.companies)
            AND l.started_at >= rk.attempted_at
        );
      IF v_retry_dead IS NOT NULL THEN
        v_msg := 'Retry de kick sem efeito (>'||v_retry_dead_mins||'min sem sinal no log — o retry também morreu no transporte): '||array_to_string(v_retry_dead, ', ');
        INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
        VALUES (c, 'sync_retry_sem_efeito', 'aviso', v_msg,
                jsonb_build_object('recursos', v_retry_dead, 'janela_mins', v_retry_dead_mins))
        ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
        IF FOUND THEN
          INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
          VALUES (c, 'outro', 'atencao', '[Sync retry] '||upper(c), v_msg, 'pendente_notificacao');
        END IF;
      ELSE
        UPDATE fin_alertas SET dismissed_at = now()
        WHERE company = c AND tipo = 'sync_retry_sem_efeito' AND dismissed_at IS NULL;
      END IF;
    END IF;
  END LOOP;
END;
$function$;

COMMIT;
