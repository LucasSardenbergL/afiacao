-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- Tintométrico — a promoção de fórmulas escreve só o que mudou (programa Mini)
--
-- O CUSTO (medido 2026-11-02/03 via psql-ro, porte Mini, shared_buffers 256MB):
--   o run de formulas dc93c806 (OBEN/M01) tinha 606 stagings = 275 chaves em 44 pares
--   (cod_produto, id_base); 599 das 606 eram IDÊNTICAS à versão anterior da mesma chave (2 chaves
--   novas, 1 header e 4 receitas mudaram). A promoção reexpande o PAR inteiro (todas as cores ×
--   embalagens — granularidade #3333/#3355, mantida aqui) e, para cada uma das 408.470 chaves, fazia
--   upsert com DO UPDATE incondicional (updated_at, importacao_id) + DELETE e re-INSERT de toda a
--   receita (~1,5 M itens). 14 min 59 s; o banco leu 11.693 MB do disco em 15 min (hit 96,87%,
--   1.188 MB de temp): tint_formula_itens 7.001 MB, tint_formulas 3.692 MB. Não é varredura, é
--   rotatividade — o volume escrito expulsa o cache. Runs de 16 stagings reescreviam 130–140 mil.
--
-- A CORREÇÃO (nada muda no catálogo oficial nem na regra de preço — só deixa de reescrever igual):
--   antes do upsert, sai de _expand_uniq a chave cujo oficial JÁ É o que o upsert + DELETE/INSERT
--   gravariam E é mais novo que a staging vencedora (a prova de frescor do formula-identica.ts da
--   edge). Toda chave que difere em qualquer coisa — ou staging nova sobre oficial velho, ainda que
--   idêntica — segue o caminho antigo VERBATIM (header inteiro + receita inteira).
--   E4: "já saiu com o preço novo" passa a ser a chave ACEITA NESTA invocação (_promoted ∪ _pulados).
--   Antes vinha do importacao_id que o upsert gravava em toda chave; a pulada guarda o do último run
--   que a REESCREVEU, e um run re-promovido o reencontraria e deixaria de recalcular (Codex P1, 03/11).
--   Desvio deliberado, só em re-promoção de run JÁ promovido: a chave aceita na invocação anterior e
--   não reaceita agora passa a ser recalculada (antes ficava com o preço da 1ª invocação porque o
--   importacao_id reaproveitado coincidia) — é a intenção escrita no próprio E4.
--   Advisory lock também por ACCOUNT: tint_formulas é por account e o lock vivo é por account+store;
--   duas lojas concorrentes classificariam _pulados sem trava e comporiam um resultado que nenhuma
--   ordem serial do promote antigo produz (Codex P2; o tick já é serial, chamada direta não).
--   Novas chaves no metadata/retorno: formulas_identicas_puladas. `inserts`/registros_importados
--   seguem contando as chaves ACEITAS (reescritas + idênticas), como antes.
--
-- COMO APLICA: TRAVA (ALTER sem efeito) → PRE (md5 do prosrc vivo ∈ {predecessor revisado, este}) →
-- 8 trocas ancoradas (cada âncora casa exatamente 1 vez) + EXECUTE → PÓS (md5 = este) → REVOKE por
-- cinto → postcondição relida do catálogo. Re-aplicar é no-op. Sem índice novo, sem DDL de tabela.
-- Aplicar FORA de uma promoção em curso (a TRAVA espera o advisory/lock da função só pelo
-- lock_timeout; a promoção em voo segue com o corpo antigo até o fim da transação dela).
-- APLICAR: bun run db:aplicar supabase/migrations/20261103093424_tint_promote_escreve_so_o_que_mudou.sql
-- (sem BEGIN/COMMIT: o db:aplicar fornece a transação).
-- Prova: db/test-tint-promote-diff.sh (LOCALE_TESTE=C e LOCALE_TESTE=pt_BR.UTF-8)
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
  -- md5(prosrc) do corpo vivo em 2026-11-03 (psql-ro; = o que 20261030071806 produziu) e do corpo
  -- que esta migration produz.
  c_pred constant text := '954a96411be99c18ab4bff40df14e620';
  c_este constant text := '2c6f461f9c9d4f8c54ea817e25f88f61';
  -- (busca, troca): cada busca tem de casar exatamente 1 vez no corpo vivo.
  c_trocas constant text[][] := ARRAY[
    -- T7: serializa também por ACCOUNT (tint_formulas é por account; o lock vivo é por account+store).
    --     Sempre DEPOIS do de account+store: ordem única, sem deadlock entre promotes.
    ARRAY[
$b7$  PERFORM pg_advisory_xact_lock(hashtext('tint_sync:' || v_account || ':' || v_store));
$b7$,
$t7$  PERFORM pg_advisory_xact_lock(hashtext('tint_sync:' || v_account || ':' || v_store));
  -- (20261103093424) e por ACCOUNT: o diff classifica _pulados lendo o oficial (que é por account) sem
  -- travar linha; duas lojas da mesma account em paralelo comporiam metades de receitas (Codex P2).
  PERFORM pg_advisory_xact_lock(hashtext('tint_formulas_account:' || v_account));
$t7$],
    -- T1: contador novo.
    ARRAY[
$b1$  v_fantasmas_fonte int := 0;   -- (20261013150000)
$b1$,
$t1$  v_fantasmas_fonte int := 0;   -- (20261013150000)
  v_puladas        int := 0;    -- (20261103093424) chaves idênticas e frescas, não reescritas
$t1$],
    -- T2: o diff, imediatamente antes do upsert oficial (depois dos guards, do tombstone, do filtro de
    --     fantasma, do v_promovidas e dos stubs de corante — a receita desejada resolve todo corante).
    ARRAY[
$b2$  -- Upsert oficial em massa por uq_tint_formulas_chave; desativada_em = NULL (reativa). Captura
$b2$,
$t2$  -- ══════════════════════════════════════════════════════════════════════════
  -- [DIFF] (20261103093424) ESCREVE SÓ O QUE MUDOU — programa Mini.
  -- O par (cod_produto, id_base) reexpande TODAS as cores (granularidade #3333/#3355, mantida): o run
  -- de 02/11 tinha 606 stagings, 599 idênticas à versão anterior, e reescrevia 408.470 fórmulas e
  -- ~1,5 M itens (15 min, 11,7 GB lidos do disco no Mini). Sai de _expand_uniq a chave cujo oficial
  -- JÁ É o que o upsert + DELETE/INSERT abaixo gravariam E é mais novo que a staging vencedora:
  --   · header: ativo; nome_cor, sku_id, volume_final_ml, preço (COALESCE como no upsert) e
  --     personalizada iguais — numeric comparado pelo TEXTO (1.5 ≠ 1.500000 → reescreve, como antes);
  --   · receita: o conjunto (corante_id, ordem, qtd_ml) é o que o INSERT gravaria — MESMO DISTINCT ON,
  --     MESMO desempate, MESMO predicado de dose válida, MESMO arredondamento; vazio = vazio. ordem
  --     NULL na staging nunca casa (o INSERT abortaria o run — continua abortando);
  --   · FRESCOR: updated_at E created_at de TODO item > created_at da staging vencedora. É a prova que
  --     o formula-identica.ts (edge) usa para "o oficial reflete esta staging": staging nova sobre
  --     oficial velho é reescrita mesmo idêntica, como antes, para a prova continuar valendo.
  -- Qualquer diferença ou NULL reescreve a chave INTEIRA pelo caminho antigo, verbatim. Direção de
  -- falha: falso "diferente" custa I/O; falso "igual" exige a igualdade acima ser falsa.
  -- A chave pulada não ganha importacao_id/updated_at deste run → o E4 a exclui por _pulados.
  -- LATERAL ... LIMIT 1 e agregados por fórmula: acesso pelos índices (uq_tint_formulas_chave,
  -- (formula_id, corante_id), staging_formula_id) — sem hash join que varreria as tabelas oficiais.
  CREATE TEMP TABLE _pulados ON COMMIT DROP AS
  SELECT eu.staging_formula_id, eu.emb_id, f.id AS formula_id
  FROM _expand_uniq eu
  JOIN tint_staging_formulas sf ON sf.id = eu.staging_formula_id
  CROSS JOIN LATERAL (
    SELECT tf.id, tf.updated_at, tf.desativada_em, tf.nome_cor, tf.sku_id, tf.volume_final_ml,
           tf.preco_final_sayersystem, tf.personalizada
    FROM tint_formulas tf
    WHERE tf.account = v_account
      AND tf.cor_id = eu.cor_id AND tf.produto_id = eu.produto_id AND tf.base_id = eu.base_id
      AND COALESCE(tf.subcolecao_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE(eu.subcolecao_id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND tf.embalagem_id = eu.emb_id
    LIMIT 1
  ) f
  CROSS JOIN LATERAL (
    SELECT string_agg(fi.corante_id::text || '|' || fi.ordem::text || '|' || fi.qtd_ml::text, ','
                      ORDER BY fi.corante_id) AS receita,
           bool_and(COALESCE(fi.created_at > sf.created_at, false)) AS fresca
    FROM tint_formula_itens fi
    WHERE fi.formula_id = f.id
  ) atual
  CROSS JOIN LATERAL (
    SELECT string_agg(d.corante_id::text || '|' || COALESCE(d.ordem::text, 'null') || '|' || d.qtd_ml::text, ','
                      ORDER BY d.corante_id) AS receita
    FROM (
      SELECT DISTINCT ON (co.id)
             co.id AS corante_id, si.ordem, round((si.qtd_ml * eu.fator)::numeric, 6) AS qtd_ml
      FROM tint_staging_formula_itens si
      JOIN tint_corantes co ON co.account = v_account AND co.id_corante_sayersystem = si.id_corante
      WHERE si.staging_formula_id = eu.staging_formula_id
        AND btrim(COALESCE(si.id_corante, '')) <> ''
        AND COALESCE(si.qtd_ml > 0 AND si.qtd_ml < 'Infinity'::numeric, false)
      ORDER BY co.id, si.ordem DESC, si.qtd_ml DESC, si.id DESC
    ) d
  ) novo
  WHERE f.desativada_em IS NULL
    AND f.updated_at > sf.created_at
    AND f.nome_cor IS NOT DISTINCT FROM eu.nome_cor
    AND f.sku_id IS NOT DISTINCT FROM eu.sku_id
    AND f.volume_final_ml::text IS NOT DISTINCT FROM eu.vol_destino::text
    AND f.preco_final_sayersystem::text
        IS NOT DISTINCT FROM COALESCE(eu.preco, f.preco_final_sayersystem)::text
    AND f.personalizada IS NOT DISTINCT FROM eu.personalizada
    AND atual.receita IS NOT DISTINCT FROM novo.receita
    AND COALESCE(atual.fresca, true);   -- sem item: receita vazia = vazia (já casada acima)

  -- (staging_formula_id, emb_id) é único em _expand_uniq (mesma chave do DELETE de _eu_sem_receita).
  DELETE FROM _expand_uniq eu
  USING _pulados pu
  WHERE pu.staging_formula_id = eu.staging_formula_id AND pu.emb_id = eu.emb_id;
  GET DIAGNOSTICS v_puladas = ROW_COUNT;

  -- Upsert oficial em massa por uq_tint_formulas_chave; desativada_em = NULL (reativa). Captura
$t2$],
    -- T3: E4 por precos_base — exclui a chave aceita nesta invocação (reescrita ou pulada).
    ARRAY[
$b3$    WHERE sp.sync_run_id = p_sync_run_id
      AND f.desativada_em IS NULL
      AND (f.importacao_id IS DISTINCT FROM v_importacao_id)
$b3$,
$t3$    WHERE sp.sync_run_id = p_sync_run_id
      AND f.desativada_em IS NULL
      -- [DIFF] aceita NESTA invocação (reescrita ou idêntica) já saiu com o preço novo. Não pelo
      -- importacao_id: a pulada guarda o do último run que a reescreveu (Codex P1, 20261103093424).
      AND NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)
$t3$],
    -- T4: E4 por custo de corante — idem.
    ARRAY[
$b4$      AND f.account = v_account
      AND f.desativada_em IS NULL
      AND (f.importacao_id IS DISTINCT FROM v_importacao_id)
$b4$,
$t4$      AND f.account = v_account
      AND f.desativada_em IS NULL
      -- [DIFF] idem ao E4 de precos_base.
      AND NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)
$t4$],
    -- T5: rastro durável no run.
    ARRAY[
$b5$'fantasmas_fonte_barradas', v_fantasmas_fonte)
  WHERE id = p_sync_run_id;$b5$,
$t5$'fantasmas_fonte_barradas', v_fantasmas_fonte, 'formulas_identicas_puladas', v_puladas)
  WHERE id = p_sync_run_id;$t5$],
    -- T6: retorno.
    ARRAY[
$b6$    'fantasmas_fonte_barradas', v_fantasmas_fonte,
    'erros', v_erros,$b6$,
$t6$    'fantasmas_fonte_barradas', v_fantasmas_fonte,
    'formulas_identicas_puladas', v_puladas,
    'erros', v_erros,$t6$]
  ];
  v_oid  oid;
  v_src  text;
  v_md5  text;
  v_def  text;
  i      int;
BEGIN
  v_oid := to_regprocedure('public.tint_promote_sync_run(uuid)')::oid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'promote-diff ABORTADA: public.tint_promote_sync_run(uuid) nao existe';
  END IF;
  SELECT prosrc INTO v_src FROM pg_catalog.pg_proc WHERE oid = v_oid;
  v_md5 := md5(v_src);

  IF v_md5 = c_este THEN
    RAISE NOTICE 'promote-diff: promote ja escreve so o que mudou - no-op';
    RETURN;
  END IF;
  IF v_md5 <> c_pred THEN
    RAISE EXCEPTION 'promote-diff ABORTADA: corpo vivo do promote (md5 %) nao e o predecessor revisado (%) nem este (%) - alguem o recriou depois do pre-voo; refaca as trocas sobre o corpo novo', v_md5, c_pred, c_este;
  END IF;

  v_def := pg_get_functiondef(v_oid);
  FOR i IN 1 .. array_length(c_trocas, 1) LOOP
    IF (length(v_src) - length(replace(v_src, c_trocas[i][1], ''))) / length(c_trocas[i][1]) <> 1
       OR (length(v_def) - length(replace(v_def, c_trocas[i][1], ''))) / length(c_trocas[i][1]) <> 1 THEN
      RAISE EXCEPTION 'promote-diff ABORTADA: a ancora % nao casa exatamente 1 vez no corpo vivo', i;
    END IF;
    v_def := replace(v_def, c_trocas[i][1], c_trocas[i][2]);
  END LOOP;
  EXECUTE v_def;

  SELECT md5(prosrc) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = v_oid;
  IF v_md5 <> c_este THEN
    RAISE EXCEPTION 'promote-diff ABORTADA: pos-troca o md5 do promote e % (esperado %)', v_md5, c_este;
  END IF;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM PUBLIC, anon, authenticated;

-- ── PÓS-CONDIÇÃO (relida do catálogo) ────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_src text;
  v_cfg text[];
BEGIN
  SELECT prosrc, proconfig INTO v_src, v_cfg FROM pg_catalog.pg_proc
   WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure;
  IF position('CREATE TEMP TABLE _pulados ON COMMIT DROP AS' in v_src) = 0
     OR (length(v_src) - length(replace(v_src, 'NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)', '')))
        / length('NOT EXISTS (SELECT 1 FROM _pulados pu WHERE pu.formula_id = f.id)') <> 2
     OR (length(v_src) - length(replace(v_src, 'NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)', '')))
        / length('NOT EXISTS (SELECT 1 FROM _promoted pm WHERE pm.formula_id = f.id)') <> 2
     OR position('f.importacao_id IS DISTINCT FROM v_importacao_id' in v_src) > 0
     OR position('pg_advisory_xact_lock(hashtext(''tint_formulas_account:'' || v_account))' in v_src) = 0
     OR position('''formulas_identicas_puladas'', v_puladas)' in v_src) = 0
     -- o caminho antigo de escrita segue intacto para o que mudou
     OR position('DELETE FROM tint_formula_itens fi USING _promoted pr WHERE fi.formula_id = pr.formula_id;' in v_src) = 0 THEN
    RAISE EXCEPTION 'P1 FALHOU: o promote nao tem o diff (_pulados), a exclusao do E4 por invocacao nas 2 pontas, o lock por account, o rastro no metadata ou perdeu o caminho de reescrita';
  END IF;
  IF NOT ('search_path=public' = ANY (v_cfg)) OR NOT ('statement_timeout=300s' = ANY (v_cfg)) THEN
    RAISE EXCEPTION 'P2 FALHOU: o promote perdeu search_path/statement_timeout (proconfig %)', v_cfg;
  END IF;
  IF has_function_privilege('anon', 'public.tint_promote_sync_run(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_promote_sync_run(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: anon/authenticated executam o promote';
  END IF;
  RAISE NOTICE 'promote-diff: _pulados + E4 por invocacao nas 2 pontas + lock por account + rastro, proconfig preservado, ACL fechada';
END
$post$;
