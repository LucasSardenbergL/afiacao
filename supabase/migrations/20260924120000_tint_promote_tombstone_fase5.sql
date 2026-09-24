-- ═════════════════════════════════════════════════════════════════════════════
-- Tintométrico — Fase 5b#1: o promote PARA de ressuscitar o tombstone da Fase 5
-- (incidente 2026-09-24: POST tint-sync-agent/catalogs → 500 e /formulas → 500
-- em pares, ciclo após ciclo — o conector re-envia e falha de novo, e produto,
-- preço e receita do app ficam PARADOS atrás da loja).
--
-- A CAUSA (anunciada na própria Fase 5 — 20260727120000, linhas 136-143):
--   a Fase 5 carimbou 463.995 linhas da geração legada '1' com
--   `desativada_motivo = 'fase5_geracao_legada'` e criou a CHECK
--   `tint_formulas_motivo_exige_desativacao (desativada_em IS NOT NULL OR
--   desativada_motivo IS NULL)`. O upsert do `tint_promote_sync_run` (v6,
--   20260726120000) faz `ON CONFLICT … DO UPDATE SET desativada_em = NULL` e NÃO
--   conhece o motivo → quando uma chave carimbada entra no `_expand_uniq`, o
--   UPDATE viola a CHECK (23514) e a TRANSAÇÃO INTEIRA do promote aborta. A edge
--   marca o run `error` e devolve 500 (index.ts, ramo `promotion_error`).
--   A Fase 5 deixou isso DELIBERADO ("melhor o sync acusar do que o piso cair")
--   e registrou o conserto como "Fase 5b". Esta migration é esse conserto.
--
-- POR QUE ACONTECE NOS DOIS ENDPOINTS: o `_formulas_latest` lê o staging LATEST
--   por chave ACROSS TODOS OS RUNS dos pares afetados (e o PURGE nunca apaga o
--   latest). Staging antigo com subcoleção '1' continua sendo re-expandido
--   sempre que o par é tocado — por fórmula nova (/formulas) OU por SKU novo
--   (/catalogs, `_skus_novos`). E como o run de catalogs termina `error`, o SKU
--   segue "novo" no ciclo seguinte → falha recorrente, não pontual.
--
-- A DECISÃO (precisão > recall): o TOMBSTONE VENCE. Chave carimbada sai do
--   `_expand_uniq` ANTES do upsert — a linha oficial fica EXATAMENTE como a
--   Fase 5 deixou (inativa, carimbada, preço/itens intocados; o piso legado da
--   `v_tint_formula_canonica` continua lendo dela). As DEMAIS chaves do run
--   promovem normalmente. Hoje o estado de prod já é esse (o promote aborta e
--   nada muda) — a diferença é que o resto do lote volta a entrar.
--   Alternativa REJEITADA: reativar limpando o motivo. Re-duplicaria o catálogo
--   (as duas gerações ativas por chave — exatamente o que a Fase 5 fechou) e
--   tiraria a linha do conjunto que a canônica aceita como piso legado.
--   Contagem visível (nunca silencioso): `tint_sync_runs.metadata->>
--   'tombstones_fase5_preservados'` + campo homônimo no retorno do RPC (a edge
--   repassa em `promotion`). NÃO vira `tint_sync_errors`: é estado DECIDIDO que
--   se repete a cada ciclo — logar por linha seria ruído que afoga erro real.
--   Linha desativada pelo SNAPSHOT (motivo NULL) continua reativando como antes.
--
-- COMO APLICA: reescreve a partir do corpo VIVO (docs/agent/database.md §
--   "Trocar o gate de uma RPC grande") — `pg_get_functiondef` + 4 `replace`,
--   cada um com guard que ABORTA se o âncora não casar EXATAMENTE 1 vez; guard
--   de no-op e pós-condição que relê o catálogo. Idempotente (re-apply = NOTICE).
--   `CREATE OR REPLACE` via EXECUTE preserva o ACL (REVOKE reemitido por cinto).
--
-- ROTEIRO (SQL Editor do Lovable — o founder cola o arquivo inteiro):
--   1. Rodar. Sucesso = a última linha mostra 'tint_promote_sync_run 5b#1 OK'.
--   2. Não há deploy de edge: a edge não muda.
--   3. Validação pós-apply (psql-ro): o próximo ciclo do conector deve fechar
--      `tint_sync_runs.status='complete'` para catalogs E formulas, com
--      `metadata ? 'tombstones_fase5_preservados'`.
-- Prova: db/test-tint-promote-tombstone-fase5.sh (PG local, com falsificação).
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $mig$
DECLARE
  v_oid   oid;
  v_def   text;
  v_novo  text;
  v_marca constant text := 'v_tombstones_fase5';
  -- (âncora, substituição) — cada âncora precisa casar EXATAMENTE 1 vez no corpo vivo.
  a1 constant text := '  v_cap_limpezas   constant int := 50;';
  n1 constant text := '  v_cap_limpezas   constant int := 50;' || E'\n' ||
                      '  v_tombstones_fase5 int := 0;  -- 5b#1 (20260924120000)';
  a2 constant text := '  SELECT count(*) INTO v_promovidas FROM _expand_uniq;';
  n2 constant text :=
    '  -- 5b#1 (20260924120000): TOMBSTONE DA FASE 5 VENCE. Chave cuja linha oficial está' || E'\n' ||
    '  -- carimbada (desativada_motivo NOT NULL) NÃO é reativada: o upsert abaixo faria' || E'\n' ||
    '  -- desativada_em = NULL e violaria tint_formulas_motivo_exige_desativacao (23514),' || E'\n' ||
    '  -- abortando o promote INTEIRO (edge 500 em catalogs E formulas). A linha fica como a' || E'\n' ||
    '  -- Fase 5 deixou; o resto do run promove. Mesma chave do ON CONFLICT (uq_tint_formulas_chave).' || E'\n' ||
    '  DELETE FROM _expand_uniq eu' || E'\n' ||
    '  USING tint_formulas tf' || E'\n' ||
    '  WHERE tf.account = v_account' || E'\n' ||
    '    AND tf.cor_id = eu.cor_id' || E'\n' ||
    '    AND tf.produto_id = eu.produto_id' || E'\n' ||
    '    AND tf.base_id = eu.base_id' || E'\n' ||
    '    AND COALESCE(tf.subcolecao_id, v_zero_uuid) = COALESCE(eu.subcolecao_id, v_zero_uuid)' || E'\n' ||
    '    AND tf.embalagem_id = eu.emb_id' || E'\n' ||
    '    AND tf.desativada_motivo IS NOT NULL;' || E'\n' ||
    '  GET DIAGNOSTICS v_tombstones_fase5 = ROW_COUNT;' || E'\n' ||
    E'\n' ||
    '  SELECT count(*) INTO v_promovidas FROM _expand_uniq;';
  a3 constant text := 'jsonb_build_object(''recalculadas'', v_recalc, ''receitas_limpas'', v_limpezas)';
  n3 constant text := 'jsonb_build_object(''recalculadas'', v_recalc, ''receitas_limpas'', v_limpezas, ''tombstones_fase5_preservados'', v_tombstones_fase5)';
  a4 constant text := '    ''receitas_limpas'', v_limpezas,';
  n4 constant text := '    ''receitas_limpas'', v_limpezas,' || E'\n' ||
                      '    ''tombstones_fase5_preservados'', v_tombstones_fase5,';
  v_ancoras text[] := ARRAY[a1, a2, a3, a4];
  v_novos   text[] := ARRAY[n1, n2, n3, n4];
  i int;
  v_n int;
BEGIN
  v_oid := to_regprocedure('public.tint_promote_sync_run(uuid)')::oid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '5b#1 ABORTADA: public.tint_promote_sync_run(uuid) não existe';
  END IF;
  v_def := pg_get_functiondef(v_oid);

  IF position(v_marca in v_def) > 0 THEN
    RAISE NOTICE '5b#1 já aplicada (marca % presente) — no-op', v_marca;
    RETURN;
  END IF;

  -- Pré-flight de versão: esta reescrita pressupõe a v6 (20260726120000). Outra versão viva
  -- = divergência repo×prod → PARE e compare com pg_get_functiondef antes de seguir.
  IF position('CREATE TEMP TABLE _fl_culpa' in v_def) = 0 THEN
    RAISE EXCEPTION '5b#1 ABORTADA: tint_promote_sync_run vivo NÃO é a v6 (20260726120000) — marca _fl_culpa ausente';
  END IF;
  -- A CHECK que esta migration contorna precisa existir; sem ela (Fase 5 não aplicada) o
  -- problema não é este — aborta em vez de mudar o promote às cegas.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'tint_formulas_motivo_exige_desativacao'
                    AND conrelid = 'public.tint_formulas'::regclass) THEN
    RAISE EXCEPTION '5b#1 ABORTADA: CHECK tint_formulas_motivo_exige_desativacao ausente — a Fase 5 (20260727120000) não está em prod; o 500 tem OUTRA causa';
  END IF;

  v_novo := v_def;
  FOR i IN 1 .. array_length(v_ancoras, 1) LOOP
    v_n := (length(v_novo) - length(replace(v_novo, v_ancoras[i], ''))) / length(v_ancoras[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '5b#1 ABORTADA: âncora % casou % vez(es) no corpo vivo (esperado 1): [%]', i, v_n, v_ancoras[i];
    END IF;
    v_novo := replace(v_novo, v_ancoras[i], v_novos[i]);
  END LOOP;

  IF v_novo = v_def THEN
    RAISE EXCEPTION '5b#1 ABORTADA: replace foi no-op';
  END IF;

  EXECUTE v_novo;

  -- Pós-condição lida do CATÁLOGO (não executando a função).
  v_def := pg_get_functiondef(v_oid);
  IF position('AND tf.desativada_motivo IS NOT NULL;' in v_def) = 0
     OR position('''tombstones_fase5_preservados'', v_tombstones_fase5)' in v_def) = 0
     OR position('''tombstones_fase5_preservados'', v_tombstones_fase5,' in v_def) = 0 THEN
    RAISE EXCEPTION '5b#1 ABORTADA: pós-condição falhou — corpo gravado não contém o filtro/contador';
  END IF;
END $mig$;

REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM anon, authenticated, PUBLIC;

COMMIT;

SELECT 'tint_promote_sync_run 5b#1 OK' AS status;
