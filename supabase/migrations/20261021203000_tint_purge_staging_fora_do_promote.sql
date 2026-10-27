-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- Tintométrico — o purge de staging SUPERSEDED sai de CADA promoção e passa a rodar 1x/dia
--
-- O CUSTO (medido 2026-10-21 via psql-ro, janela de 15 min, pg_statio_user_tables):
--   tint_staging_formulas = 35.088 MB lidos do disco de 35.782 MB no banco inteiro (98%) — 124
--   varreduras sequenciais da tabela INTEIRA (291 MB) em 15 min, ~3,4 TB/dia, cache hit 11,7%.
-- A CAUSA: o bloco PURGE no fim de tint_promote_sync_run (DELETE ... created_at < now()-30d AND
--   EXISTS(linha mais nova da mesma chave)) roda em TODA promoção. São ~1.300 promoções/dia, quase
--   todas de catálogo SEM mudança (18.580 de 18.581 runs de catalogs em 14 dias com 0 efeito), e
--   95% das linhas da staging têm >30d (são as latest-por-chave que o purge preserva) — então
--   índice em created_at NÃO resolve: o predicado casa quase a tabela toda e o EXISTS faz hash join
--   da tabela consigo mesma. Cada purge varre tudo para apagar ~nada.
--
-- A CORREÇÃO:
--   1. public.tint_staging_purge() — os MESMOS 9 DELETEs, byte a byte do corpo vivo (preservam a
--      linha mais recente por chave; poupam snapshot pendente/erro), + contagem por tabela.
--      Serializa com o tick pela MESMA advisory lock (antes o purge rodava DENTRO do promote, sob
--      ela) — o tick só faz try-lock, então pula o ciclo em vez de esperar.
--   2. tint_promote_sync_run — corpo vivo menos o bloco PURGE (recorte ancorado: marcador de início
--      e de fim casam exatamente 1 vez cada). O UPDATE de runs órfãos (>30 min → error) FICA no
--      promote: é barato e o atraso de 1 dia mudaria o comportamento visível.
--   3. cron tint-staging-purge-diario às 05:23 UTC (02:23 BRT).
--
-- POR QUE NÃO MUDA RESULTADO: mesmos 9 DELETEs, mesmo predicado — só a frequência muda. Quem lê o
-- latest-por-chave sem filtro (_formulas_latest, DISTINCT ON por (created_at, id)) nunca escolhe uma
-- linha superseded, então ela viver até +24h não muda nada.
-- ⚠️ EXCEÇÃO (revisão adversária 2026-10-21): os leitores de PREÇO pegam o latest NÃO-NULO —
-- base_latest/cor_latest no promote, tint_recalc_preco_oficial e tint_calc_preco_final (custo IS NOT
-- NULL / volume_ml IS NOT NULL). Se a linha mais nova vier com custo NULL, eles caem na superseded;
-- o purge a apaga aos 30d (já era assim: o defeito é do predicado, não da frequência). A mudança só
-- desloca esse corte de "na próxima promoção após o dia 30" para "até 24h depois". Latente em prod
-- (2026-10-21: tint_staging_precos_base com 0 linhas; corantes com custo NULL em 100%).
-- Snapshot de chaves: o purge apaga snapshot 'aplicado' >30d mesmo sendo o ÚNICO (já era assim).
--
-- COMO APLICA: TRAVA (ALTER sem efeito) → PRE (md5 do prosrc vivo ∈ {predecessor revisado, este})
-- → recorte ancorado + EXECUTE → PÓS (md5 = este). Re-aplicar é no-op. REVOKE por cinto.
-- APLICAR: bun run db:aplicar supabase/migrations/20261021203000_tint_purge_staging_fora_do_promote.sql
-- (sem BEGIN/COMMIT: o db:aplicar fornece a transação).
-- Prova: db/test-tint-purge-staging-diario.sh
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. O purge diário ────────────────────────────────────────────────────────────────────────────
-- Guarda: re-aplicar este arquivo depois que uma versão futura do purge entrar NÃO pode revertê-la
-- calado — corpo existente que não é este ABORTA.
DO $guarda_purge$
DECLARE
  c_purge constant text := '50e2c853611d115394e17c143dc3164c';
  v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_catalog.pg_proc
   WHERE oid = to_regprocedure('public.tint_staging_purge()');
  IF v_md5 IS NOT NULL AND v_md5 <> c_purge THEN
    RAISE EXCEPTION 'purge-diario ABORTADA: tint_staging_purge() já existe com outro corpo (md5 %, este %) — uma versão posterior seria revertida', v_md5, c_purge;
  END IF;
END
$guarda_purge$;

CREATE OR REPLACE FUNCTION public.tint_staging_purge()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '20min'
AS $function$
DECLARE
  v_n   bigint;
  v_res jsonb := '{}'::jsonb;
BEGIN
  -- Mesma trava do tint_promocao_tick: o purge nunca corre junto de uma promoção (antes rodava
  -- dentro dela). Espera a promoção em curso terminar (lock_timeout 20min = o statement_timeout do
  -- tick, que é o teto de uma promoção); o tick, que faz try-lock, pula enquanto isso.
  PERFORM pg_advisory_xact_lock(hashtext('tint_promocao_tick'));

  -- PURGE: NUNCA apaga a linha MAIS RECENTE por chave natural (account+store) — a promoção
  -- lê latest-staging-por-chave PRA SEMPRE (recalc por insumo + re-expansão por sku novo
  -- dependem dela mesmo que o insumo não mude por >30d → nunca é re-enviado). Só remove
  -- linhas SUPERSEDED (>30d E com uma linha mais nova da MESMA chave). §11 P2-1.
  -- Ordem de chave: (created_at, id) — idêntica ao DISTINCT ON da promoção.
  DELETE FROM tint_staging_precos_base s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_precos_base n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.cod_produto = s.cod_produto AND n.id_base = s.id_base AND n.id_embalagem = s.id_embalagem
        AND (n.created_at, n.id) > (s.created_at, s.id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_res := v_res || jsonb_build_object('tint_staging_precos_base', v_n);

  DELETE FROM tint_staging_produtos s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_produtos n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.cod_produto = s.cod_produto
        AND (n.created_at, n.id) > (s.created_at, s.id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_res := v_res || jsonb_build_object('tint_staging_produtos', v_n);

  DELETE FROM tint_staging_bases s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_bases n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.id_base_sayersystem = s.id_base_sayersystem
        AND (n.created_at, n.id) > (s.created_at, s.id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_res := v_res || jsonb_build_object('tint_staging_bases', v_n);

  DELETE FROM tint_staging_embalagens s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_embalagens n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.id_embalagem_sayersystem = s.id_embalagem_sayersystem
        AND (n.created_at, n.id) > (s.created_at, s.id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_res := v_res || jsonb_build_object('tint_staging_embalagens', v_n);

  DELETE FROM tint_staging_corantes s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_corantes n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.id_corante_sayersystem = s.id_corante_sayersystem
        AND (n.created_at, n.id) > (s.created_at, s.id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_res := v_res || jsonb_build_object('tint_staging_corantes', v_n);

  DELETE FROM tint_staging_skus s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_skus n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.cod_produto = s.cod_produto AND n.id_base = s.id_base AND n.id_embalagem = s.id_embalagem
        AND (n.created_at, n.id) > (s.created_at, s.id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_res := v_res || jsonb_build_object('tint_staging_skus', v_n);

  -- Fórmulas: chave = (cod_produto,id_base,cor_id,COALESCE(subcolecao,''),personalizada),
  -- idêntica ao DISTINCT ON de _formulas_latest. Itens cascateiam pela formula-pai apagada.
  DELETE FROM tint_staging_formula_itens si
  WHERE si.staging_formula_id IN (
    SELECT s.id FROM tint_staging_formulas s
    WHERE s.created_at < now() - interval '30 days'
      AND EXISTS (SELECT 1 FROM tint_staging_formulas n
        WHERE n.account = s.account AND n.store_code = s.store_code
          AND n.cor_id = s.cor_id AND n.cod_produto = s.cod_produto AND n.id_base = s.id_base
          AND COALESCE(n.subcolecao, '') = COALESCE(s.subcolecao, '')
          AND n.personalizada = s.personalizada
          AND (n.created_at, n.id) > (s.created_at, s.id)));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_res := v_res || jsonb_build_object('tint_staging_formula_itens', v_n);

  DELETE FROM tint_staging_formulas s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_formulas n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.cor_id = s.cor_id AND n.cod_produto = s.cod_produto AND n.id_base = s.id_base
        AND COALESCE(n.subcolecao, '') = COALESCE(s.subcolecao, '')
        AND n.personalizada = s.personalizada
        AND (n.created_at, n.id) > (s.created_at, s.id));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_res := v_res || jsonb_build_object('tint_staging_formulas', v_n);

  -- keys-snapshot: point-in-time (não latest-per-key) → purge por tempo é correto.
  -- promocao-assincrona (20260925210000): snapshot PENDENTE na fila, ou em ERRO não resolvido,
  -- não some pelo purge — apagar o erro dispensaria o alerta do watchdog sem ninguém ter
  -- reprocessado nem descartado, e levaria o payload do reprocessamento junto.
  DELETE FROM tint_keys_snapshots          WHERE created_at < now() - interval '30 days'
    AND (aplicacao_status IS NULL OR aplicacao_status NOT IN ('pendente', 'erro'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_res := v_res || jsonb_build_object('tint_keys_snapshots', v_n);

  RETURN jsonb_build_object('ok', true, 'apagadas', v_res);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.tint_staging_purge() FROM PUBLIC, anon, authenticated;

-- ── 2. O promote sem o bloco PURGE ───────────────────────────────────────────────────────────────
-- TRAVA antes de ler: ALTER sem efeito (a volatilidade VIVA é VOLATILE) prende a função até o fim da
-- transação — outra sessão não troca o corpo entre a PRE e o EXECUTE.
DO $trava$
BEGIN
  IF to_regprocedure('public.tint_promote_sync_run(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.tint_promote_sync_run(uuid) VOLATILE;
  END IF;
END
$trava$;

DO $mig$
DECLARE
  -- md5(prosrc) do corpo vivo em 2026-10-21 (psql-ro) e do corpo que esta migration produz.
  c_pred constant text := '42d09d510b02afdd4167e34ff04b2ce4';
  c_este constant text := '0e2a4169469eacb43e60eea224baad22';
  m_ini  constant text := '  -- PURGE: NUNCA apaga a linha MAIS RECENTE';
  m_fim  constant text := 'NOT IN (''pendente'', ''erro''));';
  n_rep  constant text :=
    '  -- PURGE de staging SUPERSEDED: saiu daqui em 20261021203000 e roda 1x/dia em' || E'\n' ||
    '  -- public.tint_staging_purge() (cron tint-staging-purge-diario). A cada promoção ele varria' || E'\n' ||
    '  -- tint_staging_formulas INTEIRA (~1.300x/dia, quase todas de catálogo sem mudança) = 98% da' || E'\n' ||
    '  -- leitura de disco do banco (medido 2026-10-21). Mesmos DELETEs, só a frequência mudou.';
  v_oid  oid;
  v_src  text;
  v_md5  text;
  v_def  text;
  v_ini  int;
  v_fim  int;
BEGIN
  v_oid := to_regprocedure('public.tint_promote_sync_run(uuid)')::oid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'purge-diario ABORTADA: public.tint_promote_sync_run(uuid) não existe';
  END IF;
  SELECT prosrc INTO v_src FROM pg_catalog.pg_proc WHERE oid = v_oid;
  v_md5 := md5(v_src);

  IF v_md5 = c_este THEN
    RAISE NOTICE 'purge-diario: promote já sem o purge — no-op';
    RETURN;
  END IF;
  IF v_md5 <> c_pred THEN
    RAISE EXCEPTION 'purge-diario ABORTADA: corpo vivo do promote (md5 %) não é o predecessor revisado (%) nem este (%) — alguém o recriou depois do pré-voo; refaça o recorte sobre o corpo novo', v_md5, c_pred, c_este;
  END IF;

  IF (length(v_src) - length(replace(v_src, m_ini, ''))) / length(m_ini) <> 1
     OR (length(v_src) - length(replace(v_src, m_fim, ''))) / length(m_fim) <> 1 THEN
    RAISE EXCEPTION 'purge-diario ABORTADA: marcadores do bloco PURGE não casam exatamente 1 vez cada';
  END IF;
  v_ini := position(m_ini in v_src);
  v_fim := position(m_fim in v_src) + length(m_fim);
  IF v_fim <= v_ini THEN
    RAISE EXCEPTION 'purge-diario ABORTADA: marcador de fim antes do de início';
  END IF;

  v_def := pg_get_functiondef(v_oid);
  v_def := replace(v_def, substr(v_src, v_ini, v_fim - v_ini), n_rep);
  EXECUTE v_def;

  SELECT md5(prosrc) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = v_oid;
  IF v_md5 <> c_este THEN
    RAISE EXCEPTION 'purge-diario ABORTADA: pós-recorte o md5 do promote é % (esperado %)', v_md5, c_este;
  END IF;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM PUBLIC, anon, authenticated;

-- ── 3. O cron diário ─────────────────────────────────────────────────────────────────────────────
SELECT cron.unschedule('tint-staging-purge-diario')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-staging-purge-diario');
SELECT cron.schedule(
  'tint-staging-purge-diario',
  '23 5 * * *',
  $cron$ SET statement_timeout = '30min'; SELECT public.tint_staging_purge(); $cron$
);

-- ── PÓS-CONDIÇÃO (relida do catálogo) ────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_catalog.pg_proc
   WHERE oid = to_regprocedure('public.tint_promote_sync_run(uuid)');
  IF v_src IS NULL OR position('DELETE FROM tint_staging_formulas s' in v_src) > 0
     OR position('DELETE FROM tint_keys_snapshots' in v_src) > 0
     OR position('tint_staging_purge()' in v_src) = 0
     OR position('SET status = ''error'', completed_at = COALESCE(completed_at, now())' in v_src) = 0 THEN
    RAISE EXCEPTION 'P1 FALHOU: o promote ainda tem o purge, perdeu o comentário-ponte ou perdeu o UPDATE de runs órfãos';
  END IF;

  SELECT prosrc INTO v_src FROM pg_catalog.pg_proc
   WHERE oid = to_regprocedure('public.tint_staging_purge()') AND prosecdef;
  IF v_src IS NULL OR (length(v_src) - length(replace(v_src, 'DELETE FROM ', ''))) / length('DELETE FROM ') <> 9
     OR position('pg_advisory_xact_lock(hashtext(''tint_promocao_tick''))' in v_src) = 0 THEN
    RAISE EXCEPTION 'P2 FALHOU: tint_staging_purge() ausente, sem SECURITY DEFINER, sem os 9 DELETEs ou sem a trava do tick';
  END IF;

  IF has_function_privilege('anon', 'public.tint_staging_purge()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_staging_purge()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tint_promote_sync_run(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_promote_sync_run(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: anon/authenticated executam o purge ou o promote';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-staging-purge-diario'
                   AND active AND schedule = '23 5 * * *'
                   AND command LIKE '%SELECT public.tint_staging_purge();%') THEN
    RAISE EXCEPTION 'P4 FALHOU: cron tint-staging-purge-diario ausente, inativo ou com comando errado — sem ele a staging cresce sem purge';
  END IF;
END
$post$;
