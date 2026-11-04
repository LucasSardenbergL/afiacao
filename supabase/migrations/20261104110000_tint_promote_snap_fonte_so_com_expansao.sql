-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- tint_promote_sync_run: o filtro de fantasmas da fonte (20261013150000) só materializa o snapshot de
-- chaves quando há o que filtrar — programa Mini, temp crônico.
--
-- Medida (2026-11-04, psql-ro, PR #3582): a cada ciclo do agente (~10,5 min), 20–100 s depois dos 5 runs
-- `catalogs`, entravam 45–55 MB de temp no banco (~73 MB/15 min; teto do Mini = 100 MB). Dono: o
-- `CREATE TEMP TABLE _snap_fonte AS SELECT DISTINCT chave FROM tint_keys_snapshots,
-- jsonb_array_elements_text(keys)`, que roda em TODA promoção com snapshot de fórmulas aplicado. O
-- snapshot de oben/M01 tem 123.388 chaves (3 chunks): EXPLAIN (ANALYZE, BUFFERS) em prod, work_mem 3,5 MB
-- → `HashAggregate Batches: 5 Disk Usage: 3688kB` + tuplestore do jsonb_array_elements_text, `temp
-- written=1222` (~9,5 MB) por promoção. 685 das 688 promoções/24 h são `catalogs`, e nelas o _expand_uniq
-- está VAZIO (sem staging de fórmula nem sku novo): o DELETE que consome o _snap_fonte não apaga nada.
--
-- Troca: o bloco só entra com `EXISTS (SELECT 1 FROM _expand_uniq)`. Com o _expand_uniq vazio o DELETE
-- apagaria 0 linhas e v_fantasmas_fonte ficaria 0 — exatamente o valor inicial que ele mantém agora. Com
-- expansão (run de fórmulas, ou catalogs com sku novo que reexpande o par), o filtro é o de antes, verbatim.
--
-- Molde: TRAVA → PRE (md5 do corpo vivo = o revisado) → 1 troca ancorada (casa exatamente 1 vez) +
-- EXECUTE → PÓS (md5 = este) → REVOKE por cinto → postcondição relida do catálogo. Re-aplicar é no-op.
-- APLICAR: bun run db:aplicar supabase/migrations/20261104110000_tint_promote_snap_fonte_so_com_expansao.sql
-- (sem BEGIN/COMMIT: o db:aplicar fornece a transação).
-- Prova: db/test-tint-promote-snap-fonte.sh (LOCALE_TESTE=C e LOCALE_TESTE=pt_BR.UTF-8)
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

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
  -- md5(prosrc) do corpo vivo em 2026-11-04 (psql-ro; = o c_este da 20261103093424) e do que esta produz.
  c_pred constant text := '2c6f461f9c9d4f8c54ea817e25f88f61';
  c_este constant text := '97d4424225edab7caff792b852afb371';
  c_busca constant text :=
$b1$  IF v_snap_id IS NOT NULL THEN
    CREATE TEMP TABLE _snap_fonte ON COMMIT DROP AS
$b1$;
  c_troca constant text :=
$t1$  -- (20261104110000) só com expansão: com o _expand_uniq vazio (685 de 688 promoções/dia são catalogs
  -- sem sku novo) o DELETE abaixo não apagaria nada, e o DISTINCT das ~123 mil chaves derramava ~9,5 MB
  -- de temp por promoção no Mini. v_fantasmas_fonte fica 0, como o DELETE vazio o deixaria.
  IF v_snap_id IS NOT NULL AND EXISTS (SELECT 1 FROM _expand_uniq) THEN
    CREATE TEMP TABLE _snap_fonte ON COMMIT DROP AS
$t1$;
  v_oid  oid;
  v_src  text;
  v_md5  text;
  v_def  text;
BEGIN
  v_oid := to_regprocedure('public.tint_promote_sync_run(uuid)')::oid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'promote-snap-fonte ABORTADA: public.tint_promote_sync_run(uuid) nao existe';
  END IF;
  SELECT prosrc INTO v_src FROM pg_catalog.pg_proc WHERE oid = v_oid;
  v_md5 := md5(v_src);

  IF v_md5 = c_este THEN
    RAISE NOTICE 'promote-snap-fonte: o filtro ja exige expansao - no-op';
    RETURN;
  END IF;
  IF v_md5 <> c_pred THEN
    RAISE EXCEPTION 'promote-snap-fonte ABORTADA: corpo vivo do promote (md5 %) nao e o predecessor revisado (%) nem este (%) - alguem o recriou depois do pre-voo; refaca a troca sobre o corpo novo', v_md5, c_pred, c_este;
  END IF;

  v_def := pg_get_functiondef(v_oid);
  IF (length(v_src) - length(replace(v_src, c_busca, ''))) / length(c_busca) <> 1
     OR (length(v_def) - length(replace(v_def, c_busca, ''))) / length(c_busca) <> 1 THEN
    RAISE EXCEPTION 'promote-snap-fonte ABORTADA: a ancora nao casa exatamente 1 vez no corpo vivo';
  END IF;
  EXECUTE replace(v_def, c_busca, c_troca);

  SELECT md5(prosrc) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = v_oid;
  IF v_md5 <> c_este THEN
    RAISE EXCEPTION 'promote-snap-fonte ABORTADA: pos-troca o md5 do promote e % (esperado %)', v_md5, c_este;
  END IF;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM PUBLIC, anon, authenticated;

-- ── PÓS-CONDIÇÃO (relida do catálogo) ────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_src    text;
  v_cfg    text[];
  v_expand int;
  v_guard  int;
  v_snap   int;
  v_delete int;
BEGIN
  SELECT prosrc, proconfig INTO v_src, v_cfg FROM pg_catalog.pg_proc
   WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure;
  v_expand := position('CREATE TEMP TABLE _expand_uniq ON COMMIT DROP AS' in v_src);
  v_guard  := position('IF v_snap_id IS NOT NULL AND EXISTS (SELECT 1 FROM _expand_uniq) THEN' in v_src);
  v_snap   := position('CREATE TEMP TABLE _snap_fonte ON COMMIT DROP AS' in v_src);
  v_delete := position('AND sf.created_at < v_snap_recebido' in v_src);
  -- o guard vem depois de o _expand_uniq existir e antes de o _snap_fonte nascer; o filtro segue inteiro
  IF v_expand = 0 OR v_guard = 0 OR v_snap = 0 OR v_delete = 0
     OR NOT (v_expand < v_guard AND v_guard < v_snap AND v_snap < v_delete)
     OR position('IF v_snap_id IS NOT NULL THEN' in v_src) > 0 THEN
    RAISE EXCEPTION 'P1 FALHOU: o _snap_fonte nao esta guardado pela expansao (expand % guard % snap % delete %)',
      v_expand, v_guard, v_snap, v_delete;
  END IF;
  -- IS NOT TRUE: proconfig NULL (RESET) daria ANY(NULL) = NULL e passaria calado
  IF ('search_path=public' = ANY (v_cfg)) IS NOT TRUE
     OR ('statement_timeout=300s' = ANY (v_cfg)) IS NOT TRUE THEN
    RAISE EXCEPTION 'P2 FALHOU: o promote perdeu search_path/statement_timeout (proconfig %)', v_cfg;
  END IF;
  IF has_function_privilege('anon', 'public.tint_promote_sync_run(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_promote_sync_run(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: anon/authenticated executam o promote';
  END IF;
  RAISE NOTICE 'promote-snap-fonte: _snap_fonte so com expansao, filtro intacto, config preservada, ACL fechada';
END
$post$;
