-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- Tintométrico — o "último por chave" do staging de catálogo passa a ler 1 linha por chave
-- (programa micro: caber em shared_buffers 256MB)
--
-- O CUSTO (medido 2026-10-30 via psql-ro, EXPLAIN ANALYZE BUFFERS na prod, par oben/M01):
--   o conector reenvia o catálogo inteiro a cada ciclo (~20 min): 5 runs (produtos 21 linhas,
--   embalagens 4, bases 57, skus 224, corantes 26), cada um com a sua promoção. O staging retém
--   ~2.190 versões por chave (o purge diário só apaga superseded >30d). Os blocos _tp_* do início de
--   tint_promote_sync_run pegam o latest com DISTINCT ON sobre TODAS as versões da chave:
--     · _tp_cor do run de corantes: 30.400 buffers (Index Scan em (account, id_corante) trazendo as
--       1.657 versões de cada um dos 26 corantes) — 237 MB lógicos numa promoção;
--     · o 'chaves' de corantes faz seq scan da tabela (1.400 buffers) em TODA promoção, porque
--       tint_staging_corantes não tinha índice em sync_run_id; o loop E4 (sc.sync_run_id = run AND
--       sc.custo IS NOT NULL) faz outro;
--     · _tp_sku do run de skus: parallel seq scan de 11.475 buffers (90 MB) + sort de 486k linhas com
--       spill de 23 MB em temp; _tp_base/_tp_prod/_tp_emb idem, menores.
--   Soma no small (delta pg_statio, #3422): ~66 MB/promoção em corantes, ~20 em skus, ~6 em bases.
--
-- A CORREÇÃO (só leitura de staging; nada que a promoção ESCREVE muda):
--   1. Índices (account, store_code, <chave>, created_at DESC, id DESC) em produtos, bases,
--      embalagens e corantes; (account, store_code, cod_produto, id_base, id_embalagem) em skus;
--      (sync_run_id) em corantes; e o PARCIAL de corantes WHERE custo IS NOT NULL AND volume_ml IS
--      NOT NULL, que é exatamente o filtro do cor_latest do bloco _preco (0 linhas com custo hoje).
--   2. _tp_prod/_tp_base/_tp_emb/_tp_cor: DISTINCT ON → CROSS JOIN LATERAL (... ORDER BY created_at
--      DESC, id DESC LIMIT 1) por chave do run. _tp_sku, que só projeta a própria chave: EXISTS.
--      O 'chaves' e o resto do corpo ficam byte a byte iguais. cor_latest NÃO muda de texto: o
--      índice parcial é que o faz ler só as versões com custo.
--
-- POR QUE O RESULTADO É O MESMO: DISTINCT ON (k) ... ORDER BY k, created_at DESC, id DESC devolve,
--   por k, a 1ª linha na ordem (created_at DESC NULLS FIRST, id DESC) entre as de account/store do
--   run — id é PK, a ordem é total. O LATERAL com o mesmo WHERE + ORDER BY + LIMIT 1 devolve a mesma
--   linha; o JOIN interno descarta a chave sem linha em account/store, como o JOIN do DISTINCT ON.
--   Os LATERAL projetam a chave da linha VENCEDORA (l.<chave>), como o DISTINCT ON. No _tp_sku o
--   DISTINCT ON só projetava a chave: o conjunto é {k ∈ chaves | ∃ linha de account/store com k} = o
--   EXISTS, que devolve a representação de 'chaves' — igual byte a byte porque as chaves são text
--   NOT NULL na collation default determinística (psql-ro 2026-10-30: 0 collations não determinísticas).
--
-- COMO APLICA: índices (IF NOT EXISTS) → ANALYZE → TRAVA (ALTER sem efeito) → PRE (md5 do prosrc
-- vivo ∈ {predecessor revisado, este}) → 5 trocas ancoradas (cada âncora casa exatamente 1 vez) +
-- EXECUTE → PÓS (md5 = este) → REVOKE por cinto → postcondição relida do catálogo. Re-aplicar é no-op.
-- CREATE INDEX comum (não CONCURRENTLY): trava ESCRITA no staging até o COMMIT (o lock_timeout limita a
-- ESPERA, não a retenção); a leitura e a promoção seguem. Medido em PG17 local com os volumes da prod
-- (skus 490k/85 MB): os 7 builds + ANALYZE = 1,5 s. Aplicar logo APÓS um ciclo de promoção, com a
-- próxima ingestão a ~15 min (parecer Codex: transação única aceita com a duração medida).
-- APLICAR: bun run db:aplicar supabase/migrations/20261030071806_tint_promote_latest_por_chave_indexado.sql
-- (sem BEGIN/COMMIT: o db:aplicar fornece a transação).
-- Prova: db/test-tint-promote-latest-indexado.sh
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. Índices ───────────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tsc_run
  ON public.tint_staging_corantes (sync_run_id);
CREATE INDEX IF NOT EXISTS idx_tsprod_latest
  ON public.tint_staging_produtos (account, store_code, cod_produto, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tsbase_latest
  ON public.tint_staging_bases (account, store_code, id_base_sayersystem, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tsemb_latest
  ON public.tint_staging_embalagens (account, store_code, id_embalagem_sayersystem, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tsc_latest
  ON public.tint_staging_corantes (account, store_code, id_corante_sayersystem, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tsc_latest_custo
  ON public.tint_staging_corantes (account, store_code, id_corante_sayersystem, created_at DESC, id DESC)
  WHERE custo IS NOT NULL AND volume_ml IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tss_chave
  ON public.tint_staging_skus (account, store_code, cod_produto, id_base, id_embalagem);

ANALYZE public.tint_staging_produtos, public.tint_staging_bases, public.tint_staging_embalagens,
        public.tint_staging_corantes, public.tint_staging_skus;

-- ── 2. O promote com o latest por chave indexado ─────────────────────────────────────────────────
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
  -- md5(prosrc) do corpo vivo em 2026-10-30 (psql-ro; = o que 20261021203000 produziu) e do corpo
  -- que esta migration produz.
  c_pred constant text := '0e2a4169469eacb43e60eea224baad22';
  c_este constant text := '954a96411be99c18ab4bff40df14e620';
  -- (busca, troca): cada busca tem de casar exatamente 1 vez no corpo vivo.
  c_trocas constant text[][] := ARRAY[
    ARRAY[
'  -- LATEST-STAGING-POR-CHAVE: views temporárias com a linha mais recente por chave
  -- natural (across TODOS os runs do mesmo account+store), restritas às chaves
  -- tocadas POR ESTE run (§11 P1-C). DISTINCT ON (chave) ORDER BY created_at DESC, id DESC.',
'  -- LATEST-STAGING-POR-CHAVE: views temporárias com a linha mais recente por chave
  -- natural (across TODOS os runs do mesmo account+store), restritas às chaves
  -- tocadas POR ESTE run (§11 P1-C). Por chave: ORDER BY created_at DESC, id DESC LIMIT 1 num
  -- LATERAL sobre o índice (account, store_code, chave, created_at DESC, id DESC) — 20261030071806:
  -- o DISTINCT ON lia as ~2.190 versões retidas de cada chave em toda promoção (programa micro).'],
    ARRAY[
'  latest AS (
    SELECT DISTINCT ON (s.cod_produto) s.cod_produto, s.descricao
    FROM tint_staging_produtos s
    JOIN chaves c ON c.cod_produto = s.cod_produto
    WHERE s.account = v_account AND s.store_code = v_store
    ORDER BY s.cod_produto, s.created_at DESC, s.id DESC
  )',
'  latest AS (
    SELECT l.cod_produto, l.descricao
    FROM chaves c
    CROSS JOIN LATERAL (
      SELECT s.cod_produto, s.descricao
      FROM tint_staging_produtos s
      WHERE s.account = v_account AND s.store_code = v_store AND s.cod_produto = c.cod_produto
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 1
    ) l
  )'],
    ARRAY[
'  latest AS (
    SELECT DISTINCT ON (s.id_base_sayersystem) s.id_base_sayersystem, s.descricao
    FROM tint_staging_bases s
    JOIN chaves c ON c.id_base_sayersystem = s.id_base_sayersystem
    WHERE s.account = v_account AND s.store_code = v_store
    ORDER BY s.id_base_sayersystem, s.created_at DESC, s.id DESC
  )',
'  latest AS (
    SELECT l.id_base_sayersystem, l.descricao
    FROM chaves c
    CROSS JOIN LATERAL (
      SELECT s.id_base_sayersystem, s.descricao
      FROM tint_staging_bases s
      WHERE s.account = v_account AND s.store_code = v_store AND s.id_base_sayersystem = c.id_base_sayersystem
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 1
    ) l
  )'],
    ARRAY[
'  latest AS (
    SELECT DISTINCT ON (s.id_embalagem_sayersystem) s.id_embalagem_sayersystem, s.descricao, s.volume_ml
    FROM tint_staging_embalagens s
    JOIN chaves c ON c.id_embalagem_sayersystem = s.id_embalagem_sayersystem
    WHERE s.account = v_account AND s.store_code = v_store
    ORDER BY s.id_embalagem_sayersystem, s.created_at DESC, s.id DESC
  )',
'  latest AS (
    SELECT l.id_embalagem_sayersystem, l.descricao, l.volume_ml
    FROM chaves c
    CROSS JOIN LATERAL (
      SELECT s.id_embalagem_sayersystem, s.descricao, s.volume_ml
      FROM tint_staging_embalagens s
      WHERE s.account = v_account AND s.store_code = v_store AND s.id_embalagem_sayersystem = c.id_embalagem_sayersystem
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 1
    ) l
  )'],
    ARRAY[
'  latest AS (
    SELECT DISTINCT ON (s.id_corante_sayersystem)
           s.id_corante_sayersystem, s.descricao, s.preco_litro, s.custo, s.volume_ml
    FROM tint_staging_corantes s
    JOIN chaves c ON c.id_corante_sayersystem = s.id_corante_sayersystem
    WHERE s.account = v_account AND s.store_code = v_store
    ORDER BY s.id_corante_sayersystem, s.created_at DESC, s.id DESC
  )',
'  latest AS (
    SELECT l.id_corante_sayersystem, l.descricao, l.preco_litro, l.custo, l.volume_ml
    FROM chaves c
    CROSS JOIN LATERAL (
      SELECT s.id_corante_sayersystem, s.descricao, s.preco_litro, s.custo, s.volume_ml
      FROM tint_staging_corantes s
      WHERE s.account = v_account AND s.store_code = v_store AND s.id_corante_sayersystem = c.id_corante_sayersystem
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 1
    ) l
  )'],
    ARRAY[
'  latest AS (
    SELECT DISTINCT ON (s.cod_produto, s.id_base, s.id_embalagem)
           s.cod_produto, s.id_base, s.id_embalagem
    FROM tint_staging_skus s
    JOIN chaves c ON c.cod_produto = s.cod_produto AND c.id_base = s.id_base AND c.id_embalagem = s.id_embalagem
    WHERE s.account = v_account AND s.store_code = v_store
    ORDER BY s.cod_produto, s.id_base, s.id_embalagem, s.created_at DESC, s.id DESC
  )',
'  latest AS (   -- só a chave é projetada: o latest é a própria chave, se ela existe em account/store
    SELECT c.cod_produto, c.id_base, c.id_embalagem
    FROM chaves c
    WHERE EXISTS (
      SELECT 1 FROM tint_staging_skus s
      WHERE s.account = v_account AND s.store_code = v_store
        AND s.cod_produto = c.cod_produto AND s.id_base = c.id_base AND s.id_embalagem = c.id_embalagem
    )
  )']
  ];
  v_oid  oid;
  v_src  text;
  v_md5  text;
  v_def  text;
  i      int;
BEGIN
  v_oid := to_regprocedure('public.tint_promote_sync_run(uuid)')::oid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'latest-indexado ABORTADA: public.tint_promote_sync_run(uuid) não existe';
  END IF;
  SELECT prosrc INTO v_src FROM pg_catalog.pg_proc WHERE oid = v_oid;
  v_md5 := md5(v_src);

  IF v_md5 = c_este THEN
    RAISE NOTICE 'latest-indexado: promote já com o latest indexado — no-op';
    RETURN;
  END IF;
  IF v_md5 <> c_pred THEN
    RAISE EXCEPTION 'latest-indexado ABORTADA: corpo vivo do promote (md5 %) não é o predecessor revisado (%) nem este (%) — alguém o recriou depois do pré-voo; refaça as trocas sobre o corpo novo', v_md5, c_pred, c_este;
  END IF;

  v_def := pg_get_functiondef(v_oid);
  FOR i IN 1 .. array_length(c_trocas, 1) LOOP
    IF (length(v_src) - length(replace(v_src, c_trocas[i][1], ''))) / length(c_trocas[i][1]) <> 1
       OR (length(v_def) - length(replace(v_def, c_trocas[i][1], ''))) / length(c_trocas[i][1]) <> 1 THEN
      RAISE EXCEPTION 'latest-indexado ABORTADA: a âncora % não casa exatamente 1 vez no corpo vivo', i;
    END IF;
    v_def := replace(v_def, c_trocas[i][1], c_trocas[i][2]);
  END LOOP;
  EXECUTE v_def;

  SELECT md5(prosrc) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = v_oid;
  IF v_md5 <> c_este THEN
    RAISE EXCEPTION 'latest-indexado ABORTADA: pós-troca o md5 do promote é % (esperado %)', v_md5, c_este;
  END IF;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM PUBLIC, anon, authenticated;

-- ── PÓS-CONDIÇÃO (relida do catálogo) ────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_src text;
  v_idx text;
  v_esperado constant text[][] := ARRAY[
    ARRAY['idx_tsc_run',         'tint_staging_corantes',   '(sync_run_id)'],
    ARRAY['idx_tsprod_latest',   'tint_staging_produtos',   '(account, store_code, cod_produto, created_at DESC, id DESC)'],
    ARRAY['idx_tsbase_latest',   'tint_staging_bases',      '(account, store_code, id_base_sayersystem, created_at DESC, id DESC)'],
    ARRAY['idx_tsemb_latest',    'tint_staging_embalagens', '(account, store_code, id_embalagem_sayersystem, created_at DESC, id DESC)'],
    ARRAY['idx_tsc_latest',      'tint_staging_corantes',   '(account, store_code, id_corante_sayersystem, created_at DESC, id DESC)'],
    ARRAY['idx_tsc_latest_custo','tint_staging_corantes',   '(account, store_code, id_corante_sayersystem, created_at DESC, id DESC) WHERE ((custo IS NOT NULL) AND (volume_ml IS NOT NULL))'],
    ARRAY['idx_tss_chave',       'tint_staging_skus',       '(account, store_code, cod_produto, id_base, id_embalagem)']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_esperado, 1) LOOP
    SELECT pg_get_indexdef(c.oid) INTO v_idx
      FROM pg_index x
      JOIN pg_class c ON c.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = v_esperado[i][1]
       AND x.indrelid = ('public.' || v_esperado[i][2])::regclass
       AND x.indisvalid AND x.indisready;
    IF v_idx IS NULL OR right(v_idx, length('USING btree ' || v_esperado[i][3])) <> 'USING btree ' || v_esperado[i][3] THEN
      RAISE EXCEPTION 'A1 FALHOU: % ausente, inválido ou com forma inesperada (%) — o latest volta a ler todas as versões', v_esperado[i][1], v_idx;
    END IF;
  END LOOP;

  SELECT prosrc INTO v_src FROM pg_catalog.pg_proc
   WHERE oid = to_regprocedure('public.tint_promote_sync_run(uuid)');
  IF v_src IS NULL
     OR (length(v_src) - length(replace(v_src, 'CROSS JOIN LATERAL (', ''))) / length('CROSS JOIN LATERAL (') <> 4
     OR position('SELECT DISTINCT ON (s.cod_produto, s.id_base, s.id_embalagem)' in v_src) > 0
     OR position('SELECT DISTINCT ON (s.id_corante_sayersystem)' in v_src) > 0
     OR position('cor_latest AS (' in v_src) = 0 THEN
    RAISE EXCEPTION 'A2 FALHOU: o promote não tem os 4 LATERAL, ainda tem o DISTINCT ON de skus/corantes ou perdeu o cor_latest';
  END IF;

  IF has_function_privilege('anon', 'public.tint_promote_sync_run(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_promote_sync_run(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: anon/authenticated executam o promote';
  END IF;
  RAISE NOTICE 'latest-indexado: 7 índices válidos, promote com 4 LATERAL + EXISTS, ACL fechada';
END
$post$;
