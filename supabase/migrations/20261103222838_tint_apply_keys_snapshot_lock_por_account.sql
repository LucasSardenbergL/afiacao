-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- tint_apply_keys_snapshot passa a serializar também por ACCOUNT (P2 residual do Codex, 2ª rodada de
-- 20261103093424_tint_promote_escreve_so_o_que_mudou.sql).
--
-- O promote classifica _pulados lendo o oficial da ACCOUNT (tint_formulas é por account) e, desde
-- 20261103093424, toma o lock 'tint_formulas_account:<account>' depois do de loja. O apply do keys-
-- snapshot desativa fórmulas ATIVAS da account inteira, mas só tomava o lock de loja
-- ('tint_sync:<account>:<store>'): um apply da loja B podia desativar uma chave entre a classificação e
-- o fim de um promote da loja A, e o promote deixaria pulada (sem reescrever) uma chave que acabou
-- desativada. Só alcançável fora do tint_promocao_tick (o único chamador dos dois, e serial).
--
-- Troca: depois do lock de loja, o MESMO lock por account do promote. Ordem única nos dois (loja →
-- account): sem deadlock entre promote e apply.
--
-- Molde: TRAVA → PRE (md5 do corpo vivo = o revisado) → 1 troca ancorada (casa exatamente 1 vez) +
-- EXECUTE → PÓS (md5 = este) → REVOKE por cinto → postcondição relida do catálogo. Re-aplicar é no-op.
-- APLICAR: bun run db:aplicar supabase/migrations/20261103222838_tint_apply_keys_snapshot_lock_por_account.sql
-- (sem BEGIN/COMMIT: o db:aplicar fornece a transação).
-- Prova: db/test-tint-apply-lock-account.sh (LOCALE_TESTE=C e LOCALE_TESTE=pt_BR.UTF-8)
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

-- TRAVA antes de ler: ALTER sem efeito (a volatilidade VIVA é VOLATILE) prende a função até o fim da
-- transação — outra sessão não troca o corpo entre a PRE e o EXECUTE.
DO $trava$
BEGIN
  IF to_regprocedure('public.tint_apply_keys_snapshot(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.tint_apply_keys_snapshot(uuid) VOLATILE;
  END IF;
END
$trava$;

DO $mig$
DECLARE
  -- md5(prosrc) do corpo vivo em 2026-11-03 (psql-ro) e do corpo que esta migration produz.
  c_pred constant text := '9d97ef00568816a8f799222cacf0fd18';
  c_este constant text := 'ea5acf0e873fbc7793d887f882ad47d4';
  c_busca constant text :=
$b1$  PERFORM pg_advisory_xact_lock(hashtext('tint_sync:' || v_account || ':' || v_store));
$b1$;
  c_troca constant text :=
$t1$  PERFORM pg_advisory_xact_lock(hashtext('tint_sync:' || v_account || ':' || v_store));
  -- (20261103222838) e por ACCOUNT, depois do de loja (mesma ordem do promote): a desativação lê e
  -- escreve o oficial da account inteira, que o promote de OUTRA loja classifica em _pulados.
  PERFORM pg_advisory_xact_lock(hashtext('tint_formulas_account:' || v_account));
$t1$;
  v_oid  oid;
  v_src  text;
  v_md5  text;
  v_def  text;
BEGIN
  v_oid := to_regprocedure('public.tint_apply_keys_snapshot(uuid)')::oid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'apply-lock-account ABORTADA: public.tint_apply_keys_snapshot(uuid) nao existe';
  END IF;
  SELECT prosrc INTO v_src FROM pg_catalog.pg_proc WHERE oid = v_oid;
  v_md5 := md5(v_src);

  IF v_md5 = c_este THEN
    RAISE NOTICE 'apply-lock-account: apply ja trava por account - no-op';
    RETURN;
  END IF;
  IF v_md5 <> c_pred THEN
    RAISE EXCEPTION 'apply-lock-account ABORTADA: corpo vivo do apply (md5 %) nao e o predecessor revisado (%) nem este (%) - alguem o recriou depois do pre-voo; refaca a troca sobre o corpo novo', v_md5, c_pred, c_este;
  END IF;

  v_def := pg_get_functiondef(v_oid);
  IF (length(v_src) - length(replace(v_src, c_busca, ''))) / length(c_busca) <> 1
     OR (length(v_def) - length(replace(v_def, c_busca, ''))) / length(c_busca) <> 1 THEN
    RAISE EXCEPTION 'apply-lock-account ABORTADA: a ancora nao casa exatamente 1 vez no corpo vivo';
  END IF;
  EXECUTE replace(v_def, c_busca, c_troca);

  SELECT md5(prosrc) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = v_oid;
  IF v_md5 <> c_este THEN
    RAISE EXCEPTION 'apply-lock-account ABORTADA: pos-troca o md5 do apply e % (esperado %)', v_md5, c_este;
  END IF;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.tint_apply_keys_snapshot(uuid) FROM PUBLIC, anon, authenticated;

-- ── PÓS-CONDIÇÃO (relida do catálogo) ────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_src  text;
  v_cfg  text[];
  v_loja int;
  v_conta int;
BEGIN
  SELECT prosrc, proconfig INTO v_src, v_cfg FROM pg_catalog.pg_proc
   WHERE oid = 'public.tint_apply_keys_snapshot(uuid)'::regprocedure;
  v_loja  := position('pg_advisory_xact_lock(hashtext(''tint_sync:'' || v_account || '':'' || v_store))' in v_src);
  v_conta := position('pg_advisory_xact_lock(hashtext(''tint_formulas_account:'' || v_account))' in v_src);
  -- a desativação (UPDATE do oficial) só depois dos dois locks
  IF v_loja = 0 OR v_conta = 0 OR v_conta < v_loja
     OR position('UPDATE tint_formulas SET desativada_em' in v_src) < v_conta THEN
    RAISE EXCEPTION 'P1 FALHOU: o apply nao toma o lock por account depois do de loja e antes de desativar';
  END IF;
  IF NOT ('search_path=public' = ANY (v_cfg)) THEN
    RAISE EXCEPTION 'P2 FALHOU: o apply perdeu o search_path (proconfig %)', v_cfg;
  END IF;
  IF has_function_privilege('anon', 'public.tint_apply_keys_snapshot(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_apply_keys_snapshot(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: anon/authenticated executam o apply';
  END IF;
  RAISE NOTICE 'apply-lock-account: lock de loja → account antes da desativacao, search_path preservado, ACL fechada';
END
$post$;
