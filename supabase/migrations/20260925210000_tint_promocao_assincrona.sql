-- ═════════════════════════════════════════════════════════════════════════════
-- Tintométrico — PROMOÇÃO ASSÍNCRONA do tint-sync-agent (fila + pg_cron)
--
-- O PROBLEMA (medido em prod via psql-ro, 2026-09-25):
--   A edge `tint-sync-agent` grava o staging e, em `automatic_primary`, chamava
--   `tint_promote_sync_run` DENTRO da requisição HTTP. Todo run de formulas que
--   toca >=16 pares (cod_produto,id_base) passa dos ~128s do gateway: o custo
--   escala por PAR (o `_formulas_latest` re-expande o staging LATEST de todas as
--   cores do par). Resultado em 4 dias (16/32/34/48/49 pares): `upstream request
--   timeout` → a edge marca o run `error` e devolve 500. Em 10 dias, os erros de
--   promoção foram SÓ `upstream request timeout` (11) e `lock timeout` (22) —
--   zero 23514 (a CHECK da Fase 5 não era a causa; ver tintometrico.md).
--   ⚠️ O corte do gateway NÃO cancela a query: nos 7 runs grandes o promote
--   COMMITOU no banco (tint_importacoes 'concluido', inserts = promovidas ~511k).
--   O dado entrava; o que falhava era a RESPOSTA — o conector não recebia ok,
--   não cacheava o hash, re-enviava no ciclo seguinte e re-promovia ~500k linhas
--   todo dia; e enquanto o promote segurava o advisory lock, o request seguinte
--   (catalogs/formulas/keys-snapshot) morria em `lock timeout` (authenticator:
--   lock_timeout=8s). O `SET statement_timeout='300s'` do promote é INERTE:
--   SET na definição da função não re-arma o timer do statement corrente
--   (provado em PG17 — db/test-tint-promocao-assincrona.sh, X1).
--
-- A DECISÃO: a promoção sai do HTTP. A edge grava staging, marca o run
--   `complete` + `promocao_status='pendente'` no MESMO UPDATE e responde 200.
--   Um job pg_cron SQL puro promove a fila, 1 item por tick, FIFO estrito por
--   (account,store), serializado por advisory lock. `/keys-snapshot` entra na
--   MESMA fila (senão a desativação por snapshot correria em paralelo com a
--   promoção). Só `automatic_primary` enfileira.
--
-- O QUE ESTA MIGRATION FAZ:
--   1. tint_sync_runs + promocao_status/_tentativas/_erro/_proxima_em + promovido_em.
--      NÃO reusa `status` (ingestão ≠ promoção; a UI e o conector leem `status`).
--   2. tint_keys_snapshots + aplicacao_status/_tentativas/_erro/_proxima_em +
--      aplicado_em (N linhas-chunk por snapshot, atualizadas juntas).
--   3. tint_promote_sync_run — 2 ajustes ancorados no corpo VIVO (padrão da 5b#1):
--      (a) a janela do cap de 50 limpezas/24h passa a contar pela PROMOÇÃO
--          (COALESCE(promovido_em, started_at)) — com fila, started_at pode ser
--          velho e a janela contaria menos do que limpou (bypass do cap, Codex P1);
--      (b) o purge de tint_keys_snapshots >30d poupa snapshot PENDENTE na fila ou em ERRO
--          não resolvido (apagar o erro dispensaria o alerta sem ninguém resolver).
--   4. tint_promocao_tick() — o consumidor da fila (SECURITY DEFINER, fechada).
--   5. tint_promocao_watchdog() — 2 alertas (fin_alertas + e-mail) via o helper
--      existente _tint_watchdog_fase5_transicao: `tint_promocao_erro` (itens em
--      erro NÃO resolvidos — sem janela de tempo: só sai com reenfileirar ou
--      descartar) e `tint_promocao_atrasada` (pendente há >45min: tick morto,
--      fila travada). Cron INDEPENDENTE do tick (pega tick morto).
--   6. crons: `tint-promocao-tick` ('15 seconds') e `tint-promocao-watchdog` (*/10).
--
-- REPROCESSAR / ENCERRAR (SQL Editor, founder):
--   run:      UPDATE tint_sync_runs SET promocao_status='pendente', promocao_tentativas=0,
--               promocao_erro=NULL, promocao_proxima_em=NULL WHERE id='<run>';
--   snapshot: UPDATE tint_keys_snapshots SET aplicacao_status='pendente', aplicacao_tentativas=0,
--               aplicacao_erro=NULL, aplicacao_proxima_em=NULL WHERE snapshot_id='<snap>';
--   encerrar sem reprocessar: mesmo UPDATE com status 'descartado'.
--
-- ORDEM DE DEPLOY: esta migration ANTES da edge (a edge nova grava promocao_status;
--   sem a coluna → PGRST204 → a edge devolve 500 e o sync PARA). Com a migration e
--   a edge VELHA, nada muda (a edge velha não enfileira; o tick acha a fila vazia).
-- Prova: db/test-tint-promocao-assincrona.sh (PG17 local, com falsificação).
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Estado de promoção no run ────────────────────────────────────────────
ALTER TABLE public.tint_sync_runs
  ADD COLUMN IF NOT EXISTS promocao_status     text,
  ADD COLUMN IF NOT EXISTS promocao_tentativas integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promocao_erro       text,
  ADD COLUMN IF NOT EXISTS promocao_proxima_em timestamptz,
  ADD COLUMN IF NOT EXISTS promovido_em        timestamptz;

COMMENT ON COLUMN public.tint_sync_runs.promocao_status IS
  'Fila de promoção (tint_promocao_tick): pendente → promovido | erro | descartado. NULL = run legado (promovido no HTTP) ou modo não-automático. NÃO confundir com status (ingestão).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tint_sync_runs_promocao_status_check'
                    AND conrelid = 'public.tint_sync_runs'::regclass) THEN
    ALTER TABLE public.tint_sync_runs
      ADD CONSTRAINT tint_sync_runs_promocao_status_check
      CHECK (promocao_status IS NULL OR promocao_status IN ('pendente', 'promovido', 'erro', 'descartado'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tint_sync_runs_promocao_fila
  ON public.tint_sync_runs (account, store_code, completed_at, id)
  WHERE promocao_status IN ('pendente', 'erro');

-- ── 2. Estado de aplicação no snapshot de chaves (todas as linhas-chunk juntas) ──
ALTER TABLE public.tint_keys_snapshots
  ADD COLUMN IF NOT EXISTS aplicacao_status     text,
  ADD COLUMN IF NOT EXISTS aplicacao_tentativas integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS aplicacao_erro       text,
  ADD COLUMN IF NOT EXISTS aplicacao_proxima_em timestamptz,
  ADD COLUMN IF NOT EXISTS aplicado_em          timestamptz;

COMMENT ON COLUMN public.tint_keys_snapshots.aplicacao_status IS
  'Fila de aplicação (tint_promocao_tick): pendente → aplicado | erro | descartado, igual em TODAS as linhas-chunk do snapshot_id. NULL = legado ou modo não-automático.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tint_keys_snapshots_aplicacao_status_check'
                    AND conrelid = 'public.tint_keys_snapshots'::regclass) THEN
    ALTER TABLE public.tint_keys_snapshots
      ADD CONSTRAINT tint_keys_snapshots_aplicacao_status_check
      CHECK (aplicacao_status IS NULL OR aplicacao_status IN ('pendente', 'aplicado', 'erro', 'descartado'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tint_keys_snapshots_aplicacao_fila
  ON public.tint_keys_snapshots (snapshot_id)
  WHERE aplicacao_status IN ('pendente', 'erro');

-- ── 3. tint_promote_sync_run: 2 âncoras sobre o corpo VIVO ────────────────────
DO $mig$
DECLARE
  v_oid   oid;
  v_def   text;
  v_novo  text;
  v_marca constant text := 'promocao-assincrona (20260925210000)';
  -- (a) cap de limpezas contado pela PROMOÇÃO, não pela ingestão.
  a1 constant text := '    AND tr.started_at > now() - interval ''24 hours''';
  n1 constant text :=
    '    -- promocao-assincrona (20260925210000): com a fila, started_at (ingestão) pode ser' || E'\n' ||
    '    -- MUITO anterior à promoção; contar por ele tiraria da janela limpezas recém-feitas' || E'\n' ||
    '    -- e o cap de 50/24h deixaria passar mais (Codex P1). Run legado (promovido no HTTP)' || E'\n' ||
    '    -- não tem promovido_em → started_at, que era ~ o instante da promoção.' || E'\n' ||
    '    AND COALESCE(tr.promovido_em, tr.started_at) > now() - interval ''24 hours''';
  -- (b) snapshot na fila (pendente) ou em erro NÃO RESOLVIDO não é purgado.
  a2 constant text := '  DELETE FROM tint_keys_snapshots          WHERE created_at < now() - interval ''30 days'';';
  n2 constant text :=
    '  -- promocao-assincrona (20260925210000): snapshot PENDENTE na fila, ou em ERRO não resolvido,' || E'\n' ||
    '  -- não some pelo purge — apagar o erro dispensaria o alerta do watchdog sem ninguém ter' || E'\n' ||
    '  -- reprocessado nem descartado, e levaria o payload do reprocessamento junto.' || E'\n' ||
    '  DELETE FROM tint_keys_snapshots          WHERE created_at < now() - interval ''30 days''' || E'\n' ||
    '    AND (aplicacao_status IS NULL OR aplicacao_status NOT IN (''pendente'', ''erro''));';
  v_ancoras text[] := ARRAY[a1, a2];
  v_novos   text[] := ARRAY[n1, n2];
  i int;
  v_n int;
BEGIN
  v_oid := to_regprocedure('public.tint_promote_sync_run(uuid)')::oid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'promocao-assincrona ABORTADA: public.tint_promote_sync_run(uuid) não existe';
  END IF;
  v_def := pg_get_functiondef(v_oid);

  IF position(v_marca in v_def) > 0 THEN
    RAISE NOTICE 'promocao-assincrona: promote já ajustado (marca presente) — no-op';
  ELSE
    -- Pré-flight de versão: pressupõe a v6 + 5b#1 (20260924120000), que é o corpo de prod.
    IF position('v_tombstones_fase5' in v_def) = 0 THEN
      RAISE EXCEPTION 'promocao-assincrona ABORTADA: tint_promote_sync_run vivo NÃO tem a 5b#1 (20260924120000) — aplique-a antes';
    END IF;

    v_novo := v_def;
    FOR i IN 1 .. array_length(v_ancoras, 1) LOOP
      v_n := (length(v_novo) - length(replace(v_novo, v_ancoras[i], ''))) / length(v_ancoras[i]);
      IF v_n <> 1 THEN
        RAISE EXCEPTION 'promocao-assincrona ABORTADA: âncora % casou % vez(es) no corpo vivo (esperado 1): [%]', i, v_n, v_ancoras[i];
      END IF;
      v_novo := replace(v_novo, v_ancoras[i], v_novos[i]);
    END LOOP;

    IF v_novo = v_def THEN
      RAISE EXCEPTION 'promocao-assincrona ABORTADA: replace foi no-op';
    END IF;

    EXECUTE v_novo;
  END IF;
END $mig$;

REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM anon, authenticated, PUBLIC;

-- ── 4. O consumidor da fila ─────────────────────────────────────────────────
-- 1 item por tick. Sem sobreposição (try-lock). FIFO ESTRITO por (account,store):
-- só a CABEÇA de cada grupo é elegível — um item em backoff segura o grupo, para a
-- ordem de promoção seguir a de CHEGADA (como no síncrono: um snapshot não é
-- atropelado por um run anterior a ele processado depois).
-- Falha capturada (inclusive statement_timeout = query_canceled, que OTHERS NÃO pega):
-- o parcial é desfeito pela subtransação e a tentativa conta (o UPDATE das tentativas
-- está FORA do bloco). Backend morto desfaz até a contagem — o watchdog de atraso cobre.
CREATE OR REPLACE FUNCTION public.tint_promocao_tick()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_max_tentativas constant int := 3;
  v_tipo       text;
  v_run_id     uuid;
  v_snap_id    uuid;
  v_status_run text;
  v_tent       int;
  v_n          int;
  v_res        jsonb;
  v_ok         boolean;
  v_msg        text;
  v_state      text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('tint_promocao_tick')) THEN
    RETURN jsonb_build_object('ok', true, 'acao', 'pulado_tick_concorrente');
  END IF;

  WITH fila AS (
    SELECT 'run'::text AS tipo, sr.id AS run_id, NULL::uuid AS snap_id,
           sr.account, sr.store_code,
           COALESCE(sr.completed_at, sr.started_at) AS enfileirado_em,
           sr.promocao_proxima_em AS proxima_em
      FROM tint_sync_runs sr
     WHERE sr.promocao_status = 'pendente'
    UNION ALL
    SELECT 'snapshot'::text, NULL::uuid, ks.snapshot_id,
           min(ks.account), min(ks.store_code),
           max(ks.created_at), max(ks.aplicacao_proxima_em)
      FROM tint_keys_snapshots ks
     WHERE ks.aplicacao_status = 'pendente' AND ks.entity = 'formulas'
     GROUP BY ks.snapshot_id
  ), cabeca AS (
    SELECT DISTINCT ON (f.account, f.store_code) f.*
      FROM fila f
     ORDER BY f.account, f.store_code, f.enfileirado_em, f.tipo, COALESCE(f.run_id, f.snap_id)
  )
  SELECT c.tipo, c.run_id, c.snap_id
    INTO v_tipo, v_run_id, v_snap_id
    FROM cabeca c
   WHERE c.proxima_em IS NULL OR c.proxima_em <= clock_timestamp()
   ORDER BY c.enfileirado_em, COALESCE(c.run_id, c.snap_id)
   LIMIT 1;

  IF v_tipo IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'acao', 'fila_vazia');
  END IF;

  -- ════ RUN (catalogs / formulas) ════
  IF v_tipo = 'run' THEN
    UPDATE tint_sync_runs sr
       SET promocao_tentativas = sr.promocao_tentativas + 1
     WHERE sr.id = v_run_id AND sr.promocao_status = 'pendente'
    RETURNING sr.promocao_tentativas, sr.status INTO v_tent, v_status_run;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', true, 'acao', 'corrida_item_mudou', 'run_id', v_run_id);
    END IF;

    -- A edge marca complete+pendente no MESMO UPDATE; outro status = ingestão não confirmada.
    IF v_status_run IS DISTINCT FROM 'complete' THEN
      UPDATE tint_sync_runs
         SET promocao_status = 'erro', promocao_proxima_em = NULL,
             promocao_erro = 'run com status ' || COALESCE(v_status_run, 'NULL') ||
                             ' (esperado complete): ingestão não confirmada — não promovido'
       WHERE id = v_run_id;
      RETURN jsonb_build_object('ok', false, 'acao', 'erro_status_run', 'run_id', v_run_id, 'status', v_status_run);
    END IF;

    BEGIN
      PERFORM set_config('lock_timeout', '120s', true);
      v_res := public.tint_promote_sync_run(v_run_id);
      v_ok  := COALESCE((v_res ->> 'ok')::boolean, false);
    EXCEPTION WHEN query_canceled OR others THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      v_ok := NULL;
    END;

    IF v_ok THEN
      UPDATE tint_sync_runs
         SET promocao_status = 'promovido', promovido_em = clock_timestamp(),
             promocao_erro = NULL, promocao_proxima_em = NULL
       WHERE id = v_run_id;
      RETURN jsonb_build_object('ok', true, 'acao', 'promovido', 'run_id', v_run_id,
                                'tentativa', v_tent, 'resultado', v_res);
    ELSIF v_ok IS FALSE THEN
      -- O RPC respondeu ok:false — determinístico, repetir não muda: erro direto.
      UPDATE tint_sync_runs
         SET promocao_status = 'erro', promocao_proxima_em = NULL,
             promocao_erro = left('RPC tint_promote_sync_run ok=false: ' || v_res::text, 2000)
       WHERE id = v_run_id;
      INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
      VALUES (v_run_id, 'promotion', NULL, 'promoção recusada pelo RPC (ok=false)',
              jsonb_build_object('resultado', v_res, 'origem', 'tint_promocao_tick'));
      RETURN jsonb_build_object('ok', false, 'acao', 'erro_rpc', 'run_id', v_run_id, 'resultado', v_res);
    ELSE
      UPDATE tint_sync_runs
         SET promocao_erro = left(v_state || ': ' || v_msg, 2000),
             promocao_status = CASE WHEN v_tent >= v_max_tentativas THEN 'erro' ELSE 'pendente' END,
             promocao_proxima_em = CASE WHEN v_tent >= v_max_tentativas THEN NULL
                                        ELSE clock_timestamp() + interval '1 minute' * power(2, v_tent - 1) END
       WHERE id = v_run_id;
      INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
      VALUES (v_run_id, 'promotion', NULL, v_msg,
              jsonb_build_object('sqlstate', v_state, 'tentativa', v_tent,
                                 'max_tentativas', v_max_tentativas, 'origem', 'tint_promocao_tick'));
      RETURN jsonb_build_object('ok', false, 'acao', CASE WHEN v_tent >= v_max_tentativas THEN 'erro_esgotou' ELSE 'erro_retry' END,
                                'run_id', v_run_id, 'tentativa', v_tent, 'sqlstate', v_state, 'erro', v_msg);
    END IF;
  END IF;

  -- ════ SNAPSHOT de chaves ════
  UPDATE tint_keys_snapshots ks
     SET aplicacao_tentativas = ks.aplicacao_tentativas + 1
   WHERE ks.snapshot_id = v_snap_id AND ks.entity = 'formulas' AND ks.aplicacao_status = 'pendente';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    RETURN jsonb_build_object('ok', true, 'acao', 'corrida_item_mudou', 'snapshot_id', v_snap_id);
  END IF;
  SELECT max(aplicacao_tentativas) INTO v_tent
    FROM tint_keys_snapshots WHERE snapshot_id = v_snap_id AND entity = 'formulas';

  BEGIN
    PERFORM set_config('lock_timeout', '120s', true);
    v_res := public.tint_apply_keys_snapshot(v_snap_id);
    v_ok  := COALESCE((v_res ->> 'ok')::boolean, false);
  EXCEPTION WHEN query_canceled OR others THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    v_ok := NULL;
  END;

  IF v_ok THEN
    UPDATE tint_keys_snapshots
       SET aplicacao_status = 'aplicado', aplicado_em = clock_timestamp(),
           aplicacao_erro = NULL, aplicacao_proxima_em = NULL
     WHERE snapshot_id = v_snap_id AND entity = 'formulas';
    RETURN jsonb_build_object('ok', true, 'acao', 'aplicado', 'snapshot_id', v_snap_id,
                              'tentativa', v_tent, 'resultado', v_res);
  ELSIF v_ok IS FALSE THEN
    -- blast radius / chunks incompletos: o apply já registrou run 'error' + tint_sync_errors.
    UPDATE tint_keys_snapshots
       SET aplicacao_status = 'erro', aplicacao_proxima_em = NULL,
           aplicacao_erro = left('RPC tint_apply_keys_snapshot ok=false: ' || v_res::text, 2000)
     WHERE snapshot_id = v_snap_id AND entity = 'formulas';
    RETURN jsonb_build_object('ok', false, 'acao', 'erro_rpc', 'snapshot_id', v_snap_id, 'resultado', v_res);
  ELSE
    -- (tint_sync_errors exige sync_run_id, e o run do apply foi desfeito junto: o rastro é aplicacao_erro.)
    UPDATE tint_keys_snapshots
       SET aplicacao_erro = left(v_state || ': ' || v_msg, 2000),
           aplicacao_status = CASE WHEN v_tent >= v_max_tentativas THEN 'erro' ELSE 'pendente' END,
           aplicacao_proxima_em = CASE WHEN v_tent >= v_max_tentativas THEN NULL
                                       ELSE clock_timestamp() + interval '1 minute' * power(2, v_tent - 1) END
     WHERE snapshot_id = v_snap_id AND entity = 'formulas';
    RETURN jsonb_build_object('ok', false, 'acao', CASE WHEN v_tent >= v_max_tentativas THEN 'erro_esgotou' ELSE 'erro_retry' END,
                              'snapshot_id', v_snap_id, 'tentativa', v_tent, 'sqlstate', v_state, 'erro', v_msg);
  END IF;
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.tint_promocao_tick() FROM PUBLIC, anon, authenticated;

-- ── 5. O vigia (independente do tick) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tint_promocao_watchdog()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  -- fin_alertas.company: 100% do tint é 'oben' (mesmo critério do tint_watchdog_fase5_check).
  v_conta          constant text := 'oben';
  v_limite_atraso  constant interval := interval '45 minutes';
  v_erro_runs      bigint;
  v_erro_snaps     bigint;
  v_erro           bigint;
  v_pendentes      bigint;
  v_atrasados      bigint;
  v_mais_antigo    timestamptz;
  v_msg            text;
BEGIN
  -- Erro NÃO resolvido, sem janela de tempo (Codex P1): o dado do item pode não ter entrado
  -- (o conector já cacheou o hash e não re-envia) — o sinal só sai com reenfileirar/descartar.
  SELECT count(*) INTO v_erro_runs FROM tint_sync_runs WHERE promocao_status = 'erro';
  SELECT count(DISTINCT snapshot_id) INTO v_erro_snaps
    FROM tint_keys_snapshots WHERE aplicacao_status = 'erro';
  v_erro := v_erro_runs + v_erro_snaps;

  WITH pend AS (
    SELECT COALESCE(completed_at, started_at) AS em FROM tint_sync_runs WHERE promocao_status = 'pendente'
    UNION ALL
    SELECT max(created_at) FROM tint_keys_snapshots WHERE aplicacao_status = 'pendente' GROUP BY snapshot_id
  )
  SELECT count(*), count(*) FILTER (WHERE em < clock_timestamp() - v_limite_atraso), min(em)
    INTO v_pendentes, v_atrasados, v_mais_antigo
    FROM pend;

  IF v_erro > 0 THEN
    v_msg := 'Tintometrico: ' || v_erro || ' item(ns) da fila de promocao do sync em ERRO (' ||
             v_erro_runs || ' run(s), ' || v_erro_snaps || ' snapshot(s) de chaves) apos 3 tentativas ' ||
             'ou recusa do RPC. O dado desses itens pode NAO ter entrado no catalogo, e o conector ' ||
             'NAO re-envia (ele recebeu ok). Veja promocao_erro/aplicacao_erro e, corrigida a causa, ' ||
             'REENFILEIRE (promocao_status=''pendente'', tentativas=0) ou encerre com ''descartado''. ' ||
             'Dispensar este alerta sem isso so o reabre no proximo ciclo.';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_promocao_erro', v_erro,
      CASE WHEN v_erro >= 3 THEN 'critico' ELSE 'aviso' END,
      '[Tintometrico] promocao do sync em erro', v_msg,
      jsonb_build_object('runs_erro', v_erro_runs, 'snapshots_erro', v_erro_snaps));
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_promocao_erro', 0, 'info', '', '', '{}'::jsonb);
  END IF;

  IF v_atrasados > 0 THEN
    v_msg := 'Tintometrico: ' || v_atrasados || ' item(ns) pendente(s) na fila de promocao ha mais de ' ||
             '45 min (mais antigo desde ' || to_char(v_mais_antigo AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') ||
             '). O cron tint-promocao-tick pode estar parado, ou um item em retry segura a fila. ' ||
             'Confira cron.job_run_details e promocao_erro.';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_promocao_atrasada', v_atrasados,
      CASE WHEN v_mais_antigo < clock_timestamp() - interval '3 hours' THEN 'critico' ELSE 'aviso' END,
      '[Tintometrico] fila de promocao do sync atrasada', v_msg,
      jsonb_build_object('atrasados', v_atrasados, 'pendentes', v_pendentes, 'mais_antigo', v_mais_antigo));
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_promocao_atrasada', 0, 'info', '', '', '{}'::jsonb);
  END IF;

  RETURN jsonb_build_object('ok', true, 'erro', v_erro, 'pendentes', v_pendentes, 'atrasados', v_atrasados);
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.tint_promocao_watchdog() FROM PUBLIC, anon, authenticated;

-- ── 6. Crons (SQL puro, sem net.http_post) ──────────────────────────────────
-- statement_timeout no COMANDO: SET dentro da função não vale pro statement corrente.
SELECT cron.unschedule('tint-promocao-tick')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-promocao-tick');
SELECT cron.schedule(
  'tint-promocao-tick',
  '15 seconds',
  $cron$ SET statement_timeout = '20min'; SELECT public.tint_promocao_tick(); $cron$
);

SELECT cron.unschedule('tint-promocao-watchdog')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-promocao-watchdog');
SELECT cron.schedule(
  'tint-promocao-watchdog',
  '*/10 * * * *',
  $cron$ SELECT public.tint_promocao_watchdog(); $cron$
);

-- ── Postcondição: relê o catálogo e ABORTA se algo não pegou ────────────────
DO $post$
DECLARE
  v_def text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tint_sync_runs'
         AND column_name IN ('promocao_status', 'promocao_tentativas', 'promocao_erro',
                             'promocao_proxima_em', 'promovido_em')) <> 5 THEN
    RAISE EXCEPTION 'P1 FALHOU: colunas de promoção ausentes em tint_sync_runs — a edge nova daria PGRST204';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'tint_keys_snapshots'
         AND column_name IN ('aplicacao_status', 'aplicacao_tentativas', 'aplicacao_erro',
                             'aplicacao_proxima_em', 'aplicado_em')) <> 5 THEN
    RAISE EXCEPTION 'P2 FALHOU: colunas de aplicação ausentes em tint_keys_snapshots';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tint_sync_runs_promocao_status_check' AND convalidated)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tint_keys_snapshots_aplicacao_status_check' AND convalidated) THEN
    RAISE EXCEPTION 'P3 FALHOU: CHECK de domínio do estado ausente/NOT VALID';
  END IF;

  v_def := pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure);
  IF position('AND COALESCE(tr.promovido_em, tr.started_at) > now() - interval ''24 hours''' in v_def) = 0
     OR position('AND (aplicacao_status IS NULL OR aplicacao_status NOT IN (''pendente'', ''erro''));' in v_def) = 0
     OR position('AND tr.started_at > now() - interval ''24 hours''' in v_def) > 0 THEN
    RAISE EXCEPTION 'P4 FALHOU: tint_promote_sync_run sem os ajustes da fila (cap pela promoção / purge poupa pendente e erro)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.tint_promocao_tick()'::regprocedure AND prosecdef)
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.tint_promocao_watchdog()'::regprocedure AND prosecdef) THEN
    RAISE EXCEPTION 'P5 FALHOU: tick/watchdog ausentes ou não SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.tint_promocao_tick()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_promocao_tick()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tint_promocao_watchdog()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_promocao_watchdog()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tint_promote_sync_run(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_promote_sync_run(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P6 FALHOU: função da fila executável por anon/authenticated (SECURITY DEFINER aberta)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-promocao-tick' AND active
                    AND schedule = '15 seconds'
                    AND command LIKE '%statement_timeout%' AND command LIKE '%public.tint_promocao_tick()%')
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-promocao-watchdog' AND active
                    AND schedule = '*/10 * * * *' AND command LIKE '%public.tint_promocao_watchdog()%') THEN
    RAISE EXCEPTION 'P7 FALHOU: crons da fila ausentes/inativos/com comando errado — a fila não seria consumida';
  END IF;
END
$post$;

COMMIT;

SELECT 'tint promocao assincrona OK' AS status;
