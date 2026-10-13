-- ============================================================
-- Watchdog diário: e-mail SÓ quando há problema + "OK" curto às segundas (pedido do founder, 2026-10-13).
--
-- Até aqui o cron `fin-sync-heartbeat` (0 11 * * 1-5 = 08:00 BRT, seg–sex) chamava
-- `fin_sync_heartbeat()`, que enfileira TODO dia o resumo completo ("[Watchdog OK]" + 9 linhas de sync
-- + 24 checks "ok"). Com tudo verde, o e-mail é ruído; com algo vermelho, o problema se perde entre
-- as linhas "ok" e não diz o que fazer.
--
-- Nova função `fin_sync_watchdog_diario(p_agora)`, chamada pelo MESMO job:
--   • há alerta ativo (fin_alertas `sync_%` / `data_health_%`, os mesmos que o título do heartbeat
--     contava) → e-mail "[Watchdog: N problema(s)] DD/MM" listando SÓ os problemas, cada um com o que
--     está errado + causa provável + como corrigir + último erro (de `_data_health_compute`);
--   • nada ativo e é SEGUNDA no horário de Brasília → "[Watchdog OK] semana de DD/MM", 1 parágrafo;
--   • nada ativo nos outros dias → silêncio.
-- O OK semanal é a prova de vida (dead-man-switch): se o cron/envio morrer, a segunda sem e-mail
-- denuncia. Os pushes imediatos na transição ok→degradado (`fin_sync_watchdog_check`,
-- `data_health_watchdog`) NÃO mudam — este e-mail é o lembrete diário enquanto o problema durar.
--
-- `fin_sync_heartbeat()` NÃO é tocada: continua existindo (relatório completo sob demanda,
-- `SELECT public.fin_sync_heartbeat();`) e as provas db/test-data-health-* seguem exercitando-a.
-- A função nova não tem IN-list de sources: o conjunto vigiado é o que o watchdog grava em
-- fin_alertas — não cria um 3º lugar a manter em sincronia com `_data_health_compute`.
--
-- DONO: aplicar como `postgres` (SQL Editor do Lovable) — o `claude_rw` não tem USAGE em `cron`.
-- Idempotente: CREATE OR REPLACE + cron.schedule por nome (regrava o comando do mesmo job).
-- Prova: db/test-watchdog-diario-so-problema.sh
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fin_sync_watchdog_diario(p_agora timestamptz DEFAULT now())
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_local    timestamp := p_agora AT TIME ZONE 'America/Sao_Paulo';
  v_n        int;
  v_sev      text;
  v_det      jsonb := '{}'::jsonb;
  v_det_erro text;
  v_corpo    text := '';
  v_i        int := 0;
  r          record;
  d          jsonb;
  v_src      text;
BEGIN
  SELECT count(*),
         CASE WHEN bool_or(severidade = 'critico') THEN 'urgente' ELSE 'atencao' END
    INTO v_n, v_sev
  FROM fin_alertas
  WHERE (tipo LIKE 'sync_%' OR tipo LIKE 'data_health_%') AND dismissed_at IS NULL;

  IF v_n = 0 THEN
    IF extract(isodow FROM v_local) = 1 THEN
      INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
      VALUES ('oben', 'outro', 'info',
              '[Watchdog OK] semana de '||to_char(v_local, 'DD/MM'),
              'Tudo certo: nenhum alerta de sync nem de saúde de dados ativo agora.'||E'\n\n'||
              'Este e-mail só chega às segundas, como prova de que o vigia está vivo. '||
              'Se algo quebrar, você recebe um aviso no mesmo dia, dizendo o que corrigir. '||
              'Se uma segunda passar sem este e-mail, o próprio vigia parou.',
              'pendente_notificacao');
      RETURN 'ok_semanal';
    END IF;
    RETURN 'silencio';
  END IF;

  -- Detalhe (causa/correção) vem do compute. Se ELE quebrar, o aviso sai mesmo assim com a
  -- mensagem do alerta: degradar é certo no sensor — calar o e-mail de problema não é.
  BEGIN
    SELECT COALESCE(jsonb_object_agg(c.source, to_jsonb(c)), '{}'::jsonb)
      INTO v_det
    FROM public._data_health_compute() c;
  EXCEPTION WHEN OTHERS THEN
    v_det := '{}'::jsonb;
    v_det_erro := SQLERRM;
  END;

  FOR r IN
    SELECT a.company, a.tipo, a.severidade, a.mensagem, a.criado_em
    FROM fin_alertas a
    WHERE (a.tipo LIKE 'sync_%' OR a.tipo LIKE 'data_health_%') AND a.dismissed_at IS NULL
    ORDER BY CASE a.severidade WHEN 'critico' THEN 0 WHEN 'aviso' THEN 1 ELSE 2 END,
             a.criado_em, a.company, a.tipo
  LOOP
    v_i := v_i + 1;
    v_src := CASE WHEN r.tipo LIKE 'data_health_%' THEN substr(r.tipo, 13) END;
    d := CASE WHEN v_src IS NOT NULL THEN v_det -> v_src END;

    v_corpo := v_corpo || CASE WHEN v_i > 1 THEN E'\n\n' ELSE '' END
      || v_i || '. '
      || CASE WHEN v_src IS NOT NULL THEN 'Saúde de dados — '||v_src
              ELSE 'Sync '||r.company||' — '||r.tipo END
      || ' ['||r.severidade||', desde '
      || to_char(r.criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI')||']'
      || E'\n   O que está errado: '||r.mensagem
      || CASE WHEN d IS NOT NULL AND d->>'status' = 'ok'
              THEN E'\n   (A última medição já voltou a OK; o alerta fecha sozinho na próxima rodada do vigia.)'
              ELSE '' END
      || CASE WHEN NULLIF(d->>'probable_cause', '') IS NOT NULL
              THEN E'\n   Causa provável: '||(d->>'probable_cause') ELSE '' END
      || CASE WHEN NULLIF(d->>'how_to_fix', '') IS NOT NULL
              THEN E'\n   Como corrigir: '||(d->>'how_to_fix') ELSE '' END
      || CASE WHEN NULLIF(d->>'last_error', '') IS NOT NULL
              THEN E'\n   Último erro: '||left(d->>'last_error', 400) ELSE '' END;
  END LOOP;

  IF v_det_erro IS NOT NULL THEN
    v_corpo := v_corpo || E'\n\n(Detalhes de causa/correção indisponíveis: _data_health_compute falhou — '
               || v_det_erro || ')';
  END IF;

  INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
  VALUES ('oben', 'outro', v_sev,
          '[Watchdog: '||v_n||' problema(s)] '||to_char(v_local, 'DD/MM'),
          v_n||' problema(s) ativo(s) para corrigir:'||E'\n\n'||v_corpo||E'\n\n'||
          'Você recebe este aviso todo dia útil às 08:00 enquanto houver problema ativo.',
          'pendente_notificacao');
  RETURN 'problema';
END;
$function$;

REVOKE ALL ON FUNCTION public.fin_sync_watchdog_diario(timestamptz) FROM PUBLIC, anon, authenticated;

-- Mesmo job, mesma agenda; só troca o comando.
SELECT cron.schedule('fin-sync-heartbeat', '0 11 * * 1-5', 'SELECT public.fin_sync_watchdog_diario()');

DO $post$
BEGIN
  IF (SELECT count(*) FROM cron.job j
       WHERE j.jobname = 'fin-sync-heartbeat'
         AND j.schedule = '0 11 * * 1-5'
         AND j.command = 'SELECT public.fin_sync_watchdog_diario()'
         AND j.active) <> 1 THEN
    RAISE EXCEPTION 'WATCHDOG_DIARIO FALHOU: job fin-sync-heartbeat não aponta para fin_sync_watchdog_diario()';
  END IF;
  RAISE NOTICE 'WATCHDOG_DIARIO_OK: fin-sync-heartbeat → fin_sync_watchdog_diario() (0 11 * * 1-5)';
END
$post$;

COMMIT;
