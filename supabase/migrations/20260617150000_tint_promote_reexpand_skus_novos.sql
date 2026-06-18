-- 20260617150000_tint_promote_reexpand_skus_novos.sql
-- MUDANÇA money-path (CARGA): a re-expansão de fórmulas (E2/E3) dispara SÓ para pares de skus
-- REALMENTE NOVOS (embalagem nova p/ o par), não para TODO sku tocado no run. Incidente 17/06: o
-- flip→automatic_primary + re-envio em massa fez o run de catalogs (todos os 220 skus) re-expandir
-- TODAS as ~121k fórmulas de uma vez → gateway timeout → conexão idle-in-transaction segurando o
-- advisory lock → cascata de lock timeout (55P03) → a promoção NUNCA completou. Fix: _skus_novos
-- (pares de _tp_sku que ainda NÃO existem em tint_skus) entra no _pares no lugar de _tp_sku. Re-envio:
-- catalogs re-expande 0 (skus já existem); formulas distribuem a carga por lote. Embalagem NOVA →
-- re-expande só aquele par (§11 P1-C preservado). INCLUI o COALESCE de preço da 20260617130000
-- (CREATE OR REPLACE — a última a recriar vence). Provado em PG17 + Codex.
--
-- [HERDADO da 20260617130000_tint_promote_preserva_preco.sql:]
-- MUDANÇA money-path (PREÇO): a promoção PRESERVA preco_final_sayersystem quando o recálculo dá
-- NULL — COALESCE(novo, atual) em E2 (upsert) e E4 (recálculo por insumo). Motivo: a fonte de
-- preço da base (tint_staging_precos_base) NUNCA é populada (precos_base não existe no SayerSystem;
-- o preço do balcão vem do Omie via get_tint_price). Sem este COALESCE, o flip→automatic_primary
-- gravaria preco_final_sayersystem=NULL em TODA fórmula promovida, derrubando o PISO que
-- select-price.ts usa (regra 3: mantém o MAIOR entre calc e CSV) → subfaturaria ~19k cores onde
-- calc<CSV. Com o COALESCE, a promoção atualiza o CATÁLOGO (cores/fórmulas/itens) SEM tocar no
-- preço existente; cor NOVA fica com preço NULL (degradação honesta — sem piso histórico, o balcão
-- usa o calc do Omie). Espelha o padrão COALESCE já usado p/ corantes (preco_litro) nesta função.
-- Provado em PG17: db/test-tint-promote-preserva-preco.sh (preservação · cor-nova-NULL · recálculo
-- legítimo com precos_base · falsificação). Codex challenge (sem P1): NULL NÃO vira R$0/venda
-- indevida (gate de select-price.ts + useTintColorSelect) e o RHS do ON CONFLICT lê a linha
-- pré-update. 3 [P2] da classe "piso stale" (o COALESCE mantém o CSV quando o recálculo dá NULL
-- → o balcão, regra 3 MAIOR, pode vender CARO demais se o preço devia baixar) = a decisão §14(3)
-- (manter o CSV, NÃO baixar por engano), não regressão. Follow-up conhecido: reativação
-- (desativada_em=NULL) de cor que volta com receita diferente preserva o preço antigo como piso.
-- O RESTO é VERBATIM da 20260615160000 (a última a recriar vence; §database.md).
--
-- [HERDADO de 20260615160000_tint_promote_set_based.sql:]
-- Reescreve o MOTOR de fórmulas (E2/E3) da tint_promote_sync_run de PROCEDURAL (FOR LOOP
-- aninhado: O(fórmulas × embalagens), com tint_calc_preco_final por linha) para SET-BASED
-- (INSERT...SELECT em massa). Mesma regra de negócio, executada em lote.
--
-- Motivo (flip 15/06): o loop processava ~481k expansões 1-a-1 chamando tint_calc_preco_final
-- (subqueries por chamada) — inviável dentro do request do gateway na carga inicial (statement
-- timeout 57014 → depois lock timeout + upstream timeout em cascata). Os índices de
-- 20260615140000 ajudaram mas não bastaram: o gargalo é a NATUREZA procedural. Set-based, a
-- mesma carga roda em segundos (1 INSERT...SELECT com joins, não 481k iterações).
--
-- IDENTIDADE (money-path, precisão > recall): o conjunto de fórmulas/itens/preços promovido é
-- IDÊNTICO ao do loop. Espelho dos oráculos src/lib/tint/sync-promote.ts (expandirFormula /
-- precoFinalSayer) — mesma regra de 3 (fator = vol_destino / vol_formulacao), mesmo preço pág 9
-- (base×(1+imp/100)×(1+marg/100) + Σ corante×qtd/vol), MESMO NULL-honesto (base ausente OU
-- qualquer corante sem custo/volume → preço NULL, NUNCA 0). Provado em PG17:
-- db/test-tint-promote.sh — os 12 cenários C1-C12 (valores do oráculo, inalterados) + um cenário
-- de VOLUME que roda o loop ANTIGO (preservado via RENAME no teste) e o set-based sobre o MESMO
-- seed e exige EXCEPT vazio nos dois sentidos (identidade contábil) + falsificação.
--
-- O QUE NÃO MUDA (copiado VERBATIM da 20260611190000 — a última a recriar vence; §database.md):
--   S1 advisory lock · upsert de importação · latest-staging-por-chave (_tp_*) · E1 catálogo +
--   loop de skus · E4 recálculo por insumo (tint_recalc_preco_oficial) · E5 contadores/purge.
--   Os helpers (tint_calc_preco_final / tint_recalc_preco_oficial / tint_ensure_corante_stub /
--   tint_apply_keys_snapshot) ficam como estão (20260609150000/20260611190000) — esta migration
--   só faz CREATE OR REPLACE da tint_promote_sync_run. tint_calc_preco_final deixa de ser chamada
--   pela promoção (o preço virou CTE em massa), mas continua definida (sem DROP).
--
-- SET statement_timeout='300s' fica NO CABEÇALHO da função: CREATE OR REPLACE substitui as
-- cláusulas SET, então sem isto o ALTER de 20260615140000 seria perdido. Carga inicial é pesada
-- por natureza; deltas diários são leves. Migration manual via SQL Editor (§deploy.md).

CREATE OR REPLACE FUNCTION public.tint_promote_sync_run(p_sync_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout = '300s'
AS $$
DECLARE
  v_run            record;
  v_account        text;
  v_store          text;
  v_importacao_id  uuid;
  v_promovidas     int := 0;
  v_erros          int := 0;
  v_recalc         int := 0;
  v_tmp            int := 0;
  v_zero_uuid      constant uuid := '00000000-0000-0000-0000-000000000000';
  r                record;
  v_produto_id     uuid;
  v_base_id        uuid;
  v_subcolecao_id  uuid;
  v_sku_id         uuid;
  v_emb_id         uuid;
  v_formula_id     uuid;
  v_fator          numeric;
  v_preco          numeric;
  v_qtd_vendaveis  int;
BEGIN
  SELECT * INTO v_run FROM tint_sync_runs WHERE id = p_sync_run_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'run não encontrado');
  END IF;
  v_account := v_run.account;
  v_store   := v_run.store_code;

  -- S1 (codex P1-7): serializa promoções concorrentes do mesmo (account+store). Sem isto, dois
  -- runs simultâneos do mesmo par leem o latest-staging e escrevem o oficial interleavados (o mais
  -- VELHO podia vencer). Lock de transação → libera automaticamente no commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtext('tint_sync:' || v_account || ':' || v_store));

  -- Cria/reusa o registro de importação (reusa a tela de histórico). arquivo_hash = run_id
  -- colide com UNIQUE(account, arquivo_hash) em re-execução → ON CONFLICT reusa a linha (idempotente).
  INSERT INTO tint_importacoes (account, tipo, arquivo_nome, arquivo_hash, status)
  VALUES (v_account, 'sync_agent', 'sync:' || p_sync_run_id::text, p_sync_run_id::text, 'processando')
  ON CONFLICT (account, arquivo_hash) DO UPDATE
    SET status = 'processando', registros_importados = 0, registros_erro = 0
  RETURNING id INTO v_importacao_id;

  -- ──────────────────────────────────────────────────────────────────────────
  -- LATEST-STAGING-POR-CHAVE: views temporárias com a linha mais recente por chave
  -- natural (across TODOS os runs do mesmo account+store), restritas às chaves
  -- tocadas POR ESTE run (§11 P1-C). DISTINCT ON (chave) ORDER BY created_at DESC, id DESC.
  -- ──────────────────────────────────────────────────────────────────────────

  -- Produtos tocados pelo run → latest (descrição mais recente; stub se ausente).
  CREATE TEMP TABLE _tp_prod ON COMMIT DROP AS
  WITH chaves AS (
    SELECT DISTINCT cod_produto FROM tint_staging_produtos
    WHERE sync_run_id = p_sync_run_id AND cod_produto IS NOT NULL
  ),
  latest AS (
    SELECT DISTINCT ON (s.cod_produto) s.cod_produto, s.descricao
    FROM tint_staging_produtos s
    JOIN chaves c ON c.cod_produto = s.cod_produto
    WHERE s.account = v_account AND s.store_code = v_store
    ORDER BY s.cod_produto, s.created_at DESC, s.id DESC
  )
  SELECT cod_produto, descricao FROM latest;

  CREATE TEMP TABLE _tp_base ON COMMIT DROP AS
  WITH chaves AS (
    SELECT DISTINCT id_base_sayersystem FROM tint_staging_bases
    WHERE sync_run_id = p_sync_run_id AND id_base_sayersystem IS NOT NULL
  ),
  latest AS (
    SELECT DISTINCT ON (s.id_base_sayersystem) s.id_base_sayersystem, s.descricao
    FROM tint_staging_bases s
    JOIN chaves c ON c.id_base_sayersystem = s.id_base_sayersystem
    WHERE s.account = v_account AND s.store_code = v_store
    ORDER BY s.id_base_sayersystem, s.created_at DESC, s.id DESC
  )
  SELECT id_base_sayersystem, descricao FROM latest;

  CREATE TEMP TABLE _tp_emb ON COMMIT DROP AS
  WITH chaves AS (
    SELECT DISTINCT id_embalagem_sayersystem FROM tint_staging_embalagens
    WHERE sync_run_id = p_sync_run_id AND id_embalagem_sayersystem IS NOT NULL
  ),
  latest AS (
    SELECT DISTINCT ON (s.id_embalagem_sayersystem) s.id_embalagem_sayersystem, s.descricao, s.volume_ml
    FROM tint_staging_embalagens s
    JOIN chaves c ON c.id_embalagem_sayersystem = s.id_embalagem_sayersystem
    WHERE s.account = v_account AND s.store_code = v_store
    ORDER BY s.id_embalagem_sayersystem, s.created_at DESC, s.id DESC
  )
  SELECT id_embalagem_sayersystem, descricao, volume_ml FROM latest;

  -- Corantes tocados → latest (descricao + preco_litro + custo/volume p/ preço).
  CREATE TEMP TABLE _tp_cor ON COMMIT DROP AS
  WITH chaves AS (
    SELECT DISTINCT id_corante_sayersystem FROM tint_staging_corantes
    WHERE sync_run_id = p_sync_run_id AND id_corante_sayersystem IS NOT NULL
  ),
  latest AS (
    SELECT DISTINCT ON (s.id_corante_sayersystem)
           s.id_corante_sayersystem, s.descricao, s.preco_litro, s.custo, s.volume_ml
    FROM tint_staging_corantes s
    JOIN chaves c ON c.id_corante_sayersystem = s.id_corante_sayersystem
    WHERE s.account = v_account AND s.store_code = v_store
    ORDER BY s.id_corante_sayersystem, s.created_at DESC, s.id DESC
  )
  SELECT id_corante_sayersystem, descricao, preco_litro, custo, volume_ml FROM latest;

  -- Skus tocados → latest por (cod_produto,id_base,id_embalagem).
  CREATE TEMP TABLE _tp_sku ON COMMIT DROP AS
  WITH chaves AS (
    SELECT DISTINCT cod_produto, id_base, id_embalagem FROM tint_staging_skus
    WHERE sync_run_id = p_sync_run_id
      AND cod_produto IS NOT NULL AND id_base IS NOT NULL AND id_embalagem IS NOT NULL
  ),
  latest AS (
    SELECT DISTINCT ON (s.cod_produto, s.id_base, s.id_embalagem)
           s.cod_produto, s.id_base, s.id_embalagem
    FROM tint_staging_skus s
    JOIN chaves c ON c.cod_produto = s.cod_produto AND c.id_base = s.id_base AND c.id_embalagem = s.id_embalagem
    WHERE s.account = v_account AND s.store_code = v_store
    ORDER BY s.cod_produto, s.id_base, s.id_embalagem, s.created_at DESC, s.id DESC
  )
  SELECT cod_produto, id_base, id_embalagem FROM latest;

  -- 20260617 (fix CARGA): pares de skus REALMENTE NOVOS (ainda não existem no oficial). SÓ esses
  -- precisam re-expandir (embalagem nova p/ o par). Capturado ANTES do upsert de skus (E1/loop) —
  -- depois eles já existiriam. Sem isto, um run de catalogs com TODOS os skus re-expandiria TODAS as
  -- fórmulas de uma vez → gateway timeout → advisory lock preso → lock timeout (incidente 17/06).
  CREATE TEMP TABLE _skus_novos ON COMMIT DROP AS
  SELECT DISTINCT t.cod_produto, t.id_base
  FROM _tp_sku t
  WHERE NOT EXISTS (
    SELECT 1 FROM tint_skus sk
    JOIN tint_produtos   p ON p.id = sk.produto_id  AND p.account = v_account AND p.cod_produto             = t.cod_produto
    JOIN tint_bases      b ON b.id = sk.base_id      AND b.account = v_account AND b.id_base_sayersystem     = t.id_base
    JOIN tint_embalagens e ON e.id = sk.embalagem_id AND e.account = v_account AND e.id_embalagem_sayersystem = t.id_embalagem
  );

  -- ──────────────────────────────────────────────────────────────────────────
  -- E1) Catálogo: upsert oficial a partir do latest-staging (espelha onConflict do tint-import).
  -- ──────────────────────────────────────────────────────────────────────────
  INSERT INTO tint_produtos (account, cod_produto, descricao)
  SELECT v_account, cod_produto, COALESCE(descricao, cod_produto) FROM _tp_prod
  ON CONFLICT (account, cod_produto) DO UPDATE SET descricao = EXCLUDED.descricao;

  INSERT INTO tint_bases (account, id_base_sayersystem, descricao)
  SELECT v_account, id_base_sayersystem, COALESCE(descricao, id_base_sayersystem) FROM _tp_base
  ON CONFLICT (account, id_base_sayersystem) DO UPDATE SET descricao = EXCLUDED.descricao;

  -- volume_ml NULL/0 do staging NUNCA rebaixa o volume oficial existente (espelha o
  -- COALESCE/NULLIF do corante): senão a expansão (guard volume_ml>0) dropa as fórmulas
  -- da embalagem silenciosamente. INSERT de embalagem nova com volume NULL → stub 0 (não
  -- vendável, não satisfaz o guard de expansão). descricao idem (NULL não apaga a oficial).
  INSERT INTO tint_embalagens (account, id_embalagem_sayersystem, descricao, volume_ml)
  SELECT v_account, id_embalagem_sayersystem, COALESCE(descricao, id_embalagem_sayersystem), COALESCE(volume_ml, 0) FROM _tp_emb
  ON CONFLICT (account, id_embalagem_sayersystem) DO UPDATE
    SET descricao = COALESCE(EXCLUDED.descricao, tint_embalagens.descricao),
        volume_ml = COALESCE(NULLIF(EXCLUDED.volume_ml, 0), tint_embalagens.volume_ml);

  -- Corantes: volume_total_ml é NOT NULL no oficial → preferir staging volume_ml, senão preservar
  -- o existente, senão 1000 (default do CSV-import p/ stub). preco_litro derivado de custo/volume
  -- (R$/L) quando os dois presentes; senão preserva o staging.preco_litro.
  INSERT INTO tint_corantes (account, id_corante_sayersystem, descricao, volume_total_ml, preco_litro)
  SELECT
    v_account,
    c.id_corante_sayersystem,
    COALESCE(c.descricao, c.id_corante_sayersystem),
    COALESCE(c.volume_ml, ex.volume_total_ml, 1000),
    CASE
      WHEN c.custo IS NOT NULL AND c.volume_ml IS NOT NULL AND c.volume_ml > 0
        THEN round((c.custo / c.volume_ml * 1000)::numeric, 2)
      ELSE c.preco_litro
    END
  FROM _tp_cor c
  LEFT JOIN tint_corantes ex ON ex.account = v_account AND ex.id_corante_sayersystem = c.id_corante_sayersystem
  ON CONFLICT (account, id_corante_sayersystem) DO UPDATE
    SET descricao        = EXCLUDED.descricao,
        volume_total_ml  = EXCLUDED.volume_total_ml,
        preco_litro      = COALESCE(EXCLUDED.preco_litro, tint_corantes.preco_litro);

  -- Skus de produto_base_embalagem: resolve FKs (cria stub de produto/base/embalagem se a
  -- linha do sku referenciar id ainda não-visto no run — espelha ensure* do CSV).
  FOR r IN SELECT cod_produto, id_base, id_embalagem FROM _tp_sku LOOP
    INSERT INTO tint_produtos (account, cod_produto, descricao)
    VALUES (v_account, r.cod_produto, r.cod_produto)
    ON CONFLICT (account, cod_produto) DO NOTHING;
    INSERT INTO tint_bases (account, id_base_sayersystem, descricao)
    VALUES (v_account, r.id_base, r.id_base)
    ON CONFLICT (account, id_base_sayersystem) DO NOTHING;
    INSERT INTO tint_embalagens (account, id_embalagem_sayersystem, descricao, volume_ml)
    VALUES (v_account, r.id_embalagem, r.id_embalagem, 0)
    ON CONFLICT (account, id_embalagem_sayersystem) DO NOTHING;

    SELECT id INTO v_produto_id FROM tint_produtos WHERE account = v_account AND cod_produto = r.cod_produto;
    SELECT id INTO v_base_id    FROM tint_bases    WHERE account = v_account AND id_base_sayersystem = r.id_base;
    SELECT id INTO v_emb_id     FROM tint_embalagens WHERE account = v_account AND id_embalagem_sayersystem = r.id_embalagem;

    INSERT INTO tint_skus (account, produto_id, base_id, embalagem_id)
    VALUES (v_account, v_produto_id, v_base_id, v_emb_id)
    ON CONFLICT (account, produto_id, base_id, embalagem_id) DO NOTHING;
  END LOOP;

  -- ══════════════════════════════════════════════════════════════════════════
  -- E2/E3) Fórmulas — SET-BASED (substitui o FOR LOOP aninhado procedural).
  --   Mesma regra de negócio do loop, em massa. Pares afetados + latest-staging por chave de
  --   fórmula são VERBATIM do loop; o que muda é a expansão/preço/upsert/itens (INSERT...SELECT).
  -- ══════════════════════════════════════════════════════════════════════════

  -- Pares (cod_produto, id_base) afetados = pares com fórmula tocada NESTE run ∪ pares de sku
  -- NOVO (§11 P1-C: embalagem nova ⇒ re-expandir). 20260617 (fix CARGA): _skus_novos no lugar de
  -- _tp_sku — sku re-enviado (já existente) NÃO dispara re-expansão; senão um run de catalogs com
  -- todos os skus re-expandiria TODAS as fórmulas de uma vez (lock timeout, incidente 17/06).
  CREATE TEMP TABLE _pares ON COMMIT DROP AS
  SELECT DISTINCT cod_produto, id_base FROM (
    SELECT cod_produto, id_base FROM tint_staging_formulas
      WHERE sync_run_id = p_sync_run_id AND cod_produto IS NOT NULL AND id_base IS NOT NULL
    UNION
    SELECT cod_produto, id_base FROM _skus_novos
  ) u;

  -- Latest staging de fórmula por (cor_id, cod_produto, id_base, sub_norm, personalizada),
  -- restrita aos pares afetados — across TODOS os runs.
  CREATE TEMP TABLE _formulas_latest ON COMMIT DROP AS
  WITH alvo AS (
    SELECT s.*
    FROM tint_staging_formulas s
    JOIN _pares p ON p.cod_produto = s.cod_produto AND p.id_base = s.id_base
    WHERE s.account = v_account AND s.store_code = v_store
      AND s.cor_id IS NOT NULL AND s.cod_produto IS NOT NULL AND s.id_base IS NOT NULL
  )
  SELECT DISTINCT ON (cor_id, cod_produto, id_base, COALESCE(subcolecao, ''), personalizada)
         id AS staging_formula_id, cor_id, nome_cor, cod_produto, id_base, id_embalagem,
         subcolecao, volume_final_ml, personalizada
  FROM alvo
  ORDER BY cor_id, cod_produto, id_base, COALESCE(subcolecao, ''), personalizada,
           created_at DESC, id DESC;

  -- Resolve FK produto/base por JOIN (não SELECT por linha). LEFT JOIN p/ separar os não-resolvidos.
  CREATE TEMP TABLE _fl_resolved ON COMMIT DROP AS
  SELECT fl.*, p.id AS produto_id, b.id AS base_id
  FROM _formulas_latest fl
  LEFT JOIN tint_produtos p ON p.account = v_account AND p.cod_produto = fl.cod_produto
  LEFT JOIN tint_bases    b ON b.account = v_account AND b.id_base_sayersystem = fl.id_base;

  -- Guard 1 — produto/base não resolvido (catálogo incompleto). Espelha o 1º CONTINUE do loop.
  INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
  SELECT p_sync_run_id, 'formula_promote', fl.cor_id,
         'produto/base não resolvido (catálogo incompleto)',
         jsonb_build_object('cod_produto', fl.cod_produto, 'id_base', fl.id_base)
  FROM _fl_resolved fl
  WHERE fl.produto_id IS NULL OR fl.base_id IS NULL;
  GET DIAGNOSTICS v_tmp = ROW_COUNT; v_erros := v_erros + v_tmp;

  -- Subcoleções: ensure p/ fórmulas com produto/base resolvido e subcoleção não-vazia (o loop
  -- ensura DEPOIS do guard de produto/base, ANTES dos guards de volume/vendável). id = texto CRU.
  INSERT INTO tint_subcolecoes (account, id_subcolecao_sayersystem, descricao)
  SELECT DISTINCT v_account, fl.subcolecao, fl.subcolecao
  FROM _fl_resolved fl
  WHERE fl.produto_id IS NOT NULL AND fl.base_id IS NOT NULL
    AND fl.subcolecao IS NOT NULL AND btrim(fl.subcolecao) <> ''
  ON CONFLICT (account, id_subcolecao_sayersystem) DO NOTHING;

  -- Guard 2 — volume de formulação <= 0/nulo (entre os resolvidos). Espelha o 2º CONTINUE.
  INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
  SELECT p_sync_run_id, 'formula_promote', fl.cor_id,
         'volume de formulação <= 0 ou nulo',
         jsonb_build_object('volume_final_ml', fl.volume_final_ml)
  FROM _fl_resolved fl
  WHERE fl.produto_id IS NOT NULL AND fl.base_id IS NOT NULL
    AND (fl.volume_final_ml IS NULL OR fl.volume_final_ml <= 0);
  GET DIAGNOSTICS v_tmp = ROW_COUNT; v_erros := v_erros + v_tmp;

  -- Guard 3 — zero embalagens vendáveis para o par (entre resolvidos com volume OK). 3º CONTINUE.
  INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
  SELECT p_sync_run_id, 'formula_promote', fl.cor_id,
         'zero embalagens vendáveis para o par (produto,base)',
         jsonb_build_object('cod_produto', fl.cod_produto, 'id_base', fl.id_base)
  FROM _fl_resolved fl
  WHERE fl.produto_id IS NOT NULL AND fl.base_id IS NOT NULL
    AND fl.volume_final_ml IS NOT NULL AND fl.volume_final_ml > 0
    AND NOT EXISTS (
      SELECT 1 FROM tint_skus sk
      JOIN tint_embalagens e ON e.id = sk.embalagem_id
      WHERE sk.account = v_account AND sk.produto_id = fl.produto_id AND sk.base_id = fl.base_id
        AND e.volume_ml IS NOT NULL AND e.volume_ml > 0
    );
  GET DIAGNOSTICS v_tmp = ROW_COUNT; v_erros := v_erros + v_tmp;

  -- Expansão (regra de 3): 1 linha por (fórmula que passou TODOS os guards × embalagem vendável).
  -- fator = vol_destino / vol_formulacao (espelho expandirFormula). subcolecao_id resolvido por
  -- LEFT JOIN (NULL quando vazio). eid = chave surrogate p/ casar o preço.
  CREATE TEMP TABLE _expand ON COMMIT DROP AS
  SELECT
    row_number() OVER () AS eid,
    fl.staging_formula_id, fl.cor_id, fl.nome_cor, fl.cod_produto, fl.id_base, fl.personalizada,
    fl.subcolecao,  -- texto CRU (p/ o desempate espelhar a ordem do loop; ver _expand_uniq)
    fl.produto_id, fl.base_id,
    sub.id AS subcolecao_id,
    sk.id  AS sku_id,
    sk.embalagem_id AS emb_id,
    e.id_embalagem_sayersystem AS id_emb,
    e.volume_ml AS vol_destino,
    (e.volume_ml / fl.volume_final_ml) AS fator
  FROM _fl_resolved fl
  JOIN tint_skus sk ON sk.account = v_account AND sk.produto_id = fl.produto_id AND sk.base_id = fl.base_id
  JOIN tint_embalagens e ON e.id = sk.embalagem_id
  LEFT JOIN tint_subcolecoes sub
    ON sub.account = v_account
   AND fl.subcolecao IS NOT NULL AND btrim(fl.subcolecao) <> ''
   AND sub.id_subcolecao_sayersystem = fl.subcolecao
  WHERE fl.produto_id IS NOT NULL AND fl.base_id IS NOT NULL
    AND fl.volume_final_ml IS NOT NULL AND fl.volume_final_ml > 0
    AND e.volume_ml IS NOT NULL AND e.volume_ml > 0;

  -- v_promovidas = nº de expansões (= incrementos do loop interno, inclui colisão personalizada).
  SELECT count(*) INTO v_promovidas FROM _expand;

  -- Preço pág 9 por expansão — SET-BASED, NULL-honesto (espelho precoFinalSayer + S2 store + S3
  -- latest não-nulo). base ausente OU qualquer corante sem custo/volume(>0)/finito → preço NULL.
  CREATE TEMP TABLE _preco ON COMMIT DROP AS
  WITH base_latest AS (   -- S2: store_code; S3: custo IS NOT NULL. Latest por chave de base.
    SELECT DISTINCT ON (cod_produto, id_base, id_embalagem)
           cod_produto, id_base, id_embalagem, custo, imposto_pct, margem_pct
    FROM tint_staging_precos_base
    WHERE account = v_account AND store_code = v_store AND custo IS NOT NULL
    ORDER BY cod_produto, id_base, id_embalagem, created_at DESC, id DESC
  ),
  cor_latest AS (         -- S2: store_code; S3: custo+volume NÃO-NULOS. Latest por corante.
    SELECT DISTINCT ON (id_corante_sayersystem)
           id_corante_sayersystem, custo, volume_ml
    FROM tint_staging_corantes
    WHERE account = v_account AND store_code = v_store
      AND custo IS NOT NULL AND volume_ml IS NOT NULL
    ORDER BY id_corante_sayersystem, created_at DESC, id DESC
  ),
  itens AS (              -- Σ corantes por expansão; flag de corante faltante (NULL-honesto).
    SELECT ex.eid,
           bool_or(
             cl.id_corante_sayersystem IS NULL
             OR cl.volume_ml IS NULL OR cl.volume_ml <= 0
             OR NOT (cl.custo > '-Infinity'::numeric AND cl.custo < 'Infinity'::numeric)
           ) AS faltante,
           sum(CASE WHEN cl.volume_ml > 0 THEN (cl.custo / cl.volume_ml) * (si.qtd_ml * ex.fator) ELSE 0 END) AS soma
    FROM _expand ex
    JOIN tint_staging_formula_itens si ON si.staging_formula_id = ex.staging_formula_id
    LEFT JOIN cor_latest cl ON cl.id_corante_sayersystem = si.id_corante
    WHERE si.id_corante IS NOT NULL AND si.id_corante <> '' AND COALESCE(si.qtd_ml, 0) > 0
    GROUP BY ex.eid
  )
  SELECT
    ex.eid,
    CASE
      WHEN bl.custo IS NULL THEN NULL                                                   -- base ausente
      WHEN NOT (bl.custo > '-Infinity'::numeric AND bl.custo < 'Infinity'::numeric) THEN NULL  -- custo não-finito
      WHEN COALESCE(it.faltante, false) THEN NULL                                       -- corante sem preço
      ELSE round(
        ( bl.custo * (1 + COALESCE(bl.imposto_pct, 0) / 100) * (1 + COALESCE(bl.margem_pct, 0) / 100) )
        + COALESCE(it.soma, 0)
      , 2)
    END AS preco
  FROM _expand ex
  LEFT JOIN base_latest bl
    ON bl.cod_produto = ex.cod_produto AND bl.id_base = ex.id_base AND bl.id_embalagem = ex.id_emb
  LEFT JOIN itens it ON it.eid = ex.eid;

  -- Dedup pela CHAVE OFICIAL (uq_tint_formulas_chave — SEM personalizada): INSERT...SELECT não pode
  -- ter a mesma chave 2× no mesmo comando (cardinality violation). O loop processa _formulas_latest
  -- em ORDER BY ... COALESCE(subcolecao,'') ASC, personalizada ASC e o ÚLTIMO vence o upsert. A chave
  -- oficial COLAPSA subcoleções que resolvem ao MESMO subcolecao_id (NULL e whitespace-only viram
  -- NULL → btrim vazio), então a colisão pode ser entre linhas com COALESCE(subcolecao,'') DIFERENTE
  -- (não só personalizada). Para escolher o MESMO vencedor do loop, desempata por COALESCE(subcolecao,
  -- '') DESC PRIMEIRO, depois personalizada DESC (= o último que o loop processaria), eid DESC final.
  CREATE TEMP TABLE _expand_uniq ON COMMIT DROP AS
  SELECT DISTINCT ON (ex.cor_id, ex.produto_id, ex.base_id, COALESCE(ex.subcolecao_id, v_zero_uuid), ex.emb_id)
         ex.staging_formula_id, ex.cor_id, ex.nome_cor, ex.personalizada,
         ex.produto_id, ex.base_id, ex.subcolecao_id, ex.sku_id, ex.emb_id, ex.vol_destino, ex.fator,
         pr.preco
  FROM _expand ex
  JOIN _preco pr ON pr.eid = ex.eid
  ORDER BY ex.cor_id, ex.produto_id, ex.base_id, COALESCE(ex.subcolecao_id, v_zero_uuid), ex.emb_id,
           COALESCE(ex.subcolecao, '') DESC, ex.personalizada DESC, ex.eid DESC;

  -- Corante stubs em massa ANTES dos itens (espelha tint_ensure_corante_stub: volume 1000).
  -- A partir de _expand (todas as expansões, inclui colisão) p/ casar o side-effect do loop.
  INSERT INTO tint_corantes (account, id_corante_sayersystem, descricao, volume_total_ml)
  SELECT DISTINCT v_account, si.id_corante, si.id_corante, 1000
  FROM tint_staging_formula_itens si
  WHERE si.staging_formula_id IN (SELECT DISTINCT staging_formula_id FROM _expand)
    AND si.id_corante IS NOT NULL AND si.id_corante <> '' AND COALESCE(si.qtd_ml, 0) > 0
  ON CONFLICT (account, id_corante_sayersystem) DO NOTHING;

  -- Upsert oficial em massa por uq_tint_formulas_chave; desativada_em = NULL (reativa). Captura
  -- formula_id ↔ (staging_formula_id, fator) p/ os itens (RETURNING casado de volta ao _expand_uniq).
  CREATE TEMP TABLE _promoted ON COMMIT DROP AS
  WITH ups AS (
    INSERT INTO tint_formulas (
      account, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id, sku_id,
      volume_final_ml, preco_final_sayersystem, personalizada, importacao_id, updated_at, desativada_em
    )
    SELECT
      v_account, eu.cor_id, eu.nome_cor, eu.produto_id, eu.base_id, eu.emb_id, eu.subcolecao_id, eu.sku_id,
      eu.vol_destino, eu.preco, eu.personalizada, v_importacao_id, now(), NULL
    FROM _expand_uniq eu
    ON CONFLICT (account, cor_id, produto_id, base_id, COALESCE(subcolecao_id, '00000000-0000-0000-0000-000000000000'::uuid), embalagem_id)
    DO UPDATE SET
      nome_cor                = EXCLUDED.nome_cor,
      sku_id                  = EXCLUDED.sku_id,
      volume_final_ml         = EXCLUDED.volume_final_ml,
      -- 20260617: PRESERVA o preço existente quando o novo é NULL (precos_base vazio → eu.preco NULL).
      -- Sem isto o flip zeraria o piso de ~19k cores (calc<CSV). Espelha o COALESCE de preco_litro acima.
      preco_final_sayersystem = COALESCE(EXCLUDED.preco_final_sayersystem, tint_formulas.preco_final_sayersystem),
      personalizada           = EXCLUDED.personalizada,
      importacao_id           = EXCLUDED.importacao_id,
      updated_at              = now(),
      desativada_em           = NULL
    RETURNING id, cor_id, produto_id, base_id, subcolecao_id, embalagem_id
  )
  SELECT u.id AS formula_id, eu.staging_formula_id, eu.fator
  FROM ups u
  JOIN _expand_uniq eu
    ON eu.cor_id = u.cor_id AND eu.produto_id = u.produto_id AND eu.base_id = u.base_id
   AND COALESCE(eu.subcolecao_id, v_zero_uuid) = COALESCE(u.subcolecao_id, v_zero_uuid)
   AND eu.emb_id = u.embalagem_id;

  -- Itens em massa: limpa + reinsere (espelha o delete+insert por fórmula do loop). qtd expandida
  -- = qtd_formulacao × fator, arredondada a 6 casas (sub-µL — elimina artefato de escala da divisão
  -- numeric sem mudar o valor prático). Corante já garantido (stub acima) → JOIN resolve o id.
  DELETE FROM tint_formula_itens fi USING _promoted pr WHERE fi.formula_id = pr.formula_id;

  INSERT INTO tint_formula_itens (formula_id, corante_id, ordem, qtd_ml)
  SELECT pr.formula_id, co.id, si.ordem, round((si.qtd_ml * pr.fator)::numeric, 6)
  FROM _promoted pr
  JOIN tint_staging_formula_itens si ON si.staging_formula_id = pr.staging_formula_id
  JOIN tint_corantes co ON co.account = v_account AND co.id_corante_sayersystem = si.id_corante
  WHERE si.id_corante IS NOT NULL AND si.id_corante <> '' AND COALESCE(si.qtd_ml, 0) > 0;

  -- ──────────────────────────────────────────────────────────────────────────
  -- E4) Recálculo de preço por mudança de INSUMO (§11 P1-A — caso de uso PRINCIPAL).
  --   Run tocou precos_base/corantes → recalcula preco_final_sayersystem das fórmulas
  --   oficiais ATIVAS afetadas, SEM re-expandir itens. NÃO mexe nas fórmulas que E2 já
  --   tocou (importacao_id = v_importacao_id) — essas já saíram com o preço novo.
  -- ──────────────────────────────────────────────────────────────────────────
  -- Pares (produto,base,embalagem oficial) afetados por precos_base deste run.
  FOR r IN
    SELECT DISTINCT f.id AS formula_id, f.cor_id, p.cod_produto, b.id_base_sayersystem AS id_base, e.id_embalagem_sayersystem AS id_emb
    FROM tint_staging_precos_base sp
    JOIN tint_produtos   p ON p.account = v_account AND p.cod_produto = sp.cod_produto
    JOIN tint_bases      b ON b.account = v_account AND b.id_base_sayersystem = sp.id_base
    JOIN tint_embalagens e ON e.account = v_account AND e.id_embalagem_sayersystem = sp.id_embalagem
    JOIN tint_formulas   f ON f.account = v_account AND f.produto_id = p.id AND f.base_id = b.id AND f.embalagem_id = e.id
    WHERE sp.sync_run_id = p_sync_run_id
      AND f.desativada_em IS NULL
      AND (f.importacao_id IS DISTINCT FROM v_importacao_id)
  LOOP
    -- S2: +v_store.
    v_preco := tint_recalc_preco_oficial(v_account, v_store, r.formula_id, r.cod_produto, r.id_base, r.id_emb);
    -- 20260617: só baixa/sobe se o recálculo deu valor; NULL (sem precos_base) PRESERVA o piso atual.
    UPDATE tint_formulas SET preco_final_sayersystem = COALESCE(v_preco, preco_final_sayersystem), updated_at = now() WHERE id = r.formula_id;
    v_recalc := v_recalc + 1;
  END LOOP;

  -- Fórmulas que usam um corante cujo custo/volume mudou neste run.
  FOR r IN
    SELECT DISTINCT f.id AS formula_id, f.cor_id, pr.cod_produto, ba.id_base_sayersystem AS id_base, em.id_embalagem_sayersystem AS id_emb
    FROM tint_staging_corantes sc
    JOIN tint_corantes      co ON co.account = v_account AND co.id_corante_sayersystem = sc.id_corante_sayersystem
    JOIN tint_formula_itens fi ON fi.corante_id = co.id
    JOIN tint_formulas      f  ON f.id = fi.formula_id
    JOIN tint_produtos      pr ON pr.id = f.produto_id
    JOIN tint_bases         ba ON ba.id = f.base_id
    JOIN tint_embalagens    em ON em.id = f.embalagem_id
    WHERE sc.sync_run_id = p_sync_run_id
      AND (sc.custo IS NOT NULL OR sc.volume_ml IS NOT NULL)
      AND f.account = v_account
      AND f.desativada_em IS NULL
      AND (f.importacao_id IS DISTINCT FROM v_importacao_id)
  LOOP
    -- S2: +v_store.
    v_preco := tint_recalc_preco_oficial(v_account, v_store, r.formula_id, r.cod_produto, r.id_base, r.id_emb);
    -- 20260617: só baixa/sobe se o recálculo deu valor; NULL (sem precos_base) PRESERVA o piso atual.
    UPDATE tint_formulas SET preco_final_sayersystem = COALESCE(v_preco, preco_final_sayersystem), updated_at = now() WHERE id = r.formula_id;
    v_recalc := v_recalc + 1;
  END LOOP;

  -- ──────────────────────────────────────────────────────────────────────────
  -- E5) Contadores + purge staging SUPERSEDED >30d (preserva latest-per-key) +
  --     runs órfãos >30min → error.
  -- ──────────────────────────────────────────────────────────────────────────
  UPDATE tint_importacoes
    SET status = 'concluido', registros_importados = v_promovidas, registros_erro = v_erros
  WHERE id = v_importacao_id;

  UPDATE tint_sync_runs
    SET inserts = v_promovidas, errors = v_erros, metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('recalculadas', v_recalc)
  WHERE id = p_sync_run_id;

  -- PURGE: NUNCA apaga a linha MAIS RECENTE por chave natural (account+store) — a promoção
  -- lê latest-staging-por-chave PRA SEMPRE (recalc por insumo + re-expansão por sku novo
  -- dependem dela mesmo que o insumo não mude por >30d → nunca é re-enviado). Só remove
  -- linhas SUPERSEDED (>30d E com uma linha mais nova da MESMA chave). §11 P2-1.
  -- Ordem de chave: (created_at, id) — idêntica ao DISTINCT ON da promoção.
  DELETE FROM tint_staging_produtos s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_produtos n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.cod_produto = s.cod_produto
        AND (n.created_at, n.id) > (s.created_at, s.id));

  DELETE FROM tint_staging_bases s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_bases n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.id_base_sayersystem = s.id_base_sayersystem
        AND (n.created_at, n.id) > (s.created_at, s.id));

  DELETE FROM tint_staging_embalagens s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_embalagens n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.id_embalagem_sayersystem = s.id_embalagem_sayersystem
        AND (n.created_at, n.id) > (s.created_at, s.id));

  DELETE FROM tint_staging_corantes s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_corantes n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.id_corante_sayersystem = s.id_corante_sayersystem
        AND (n.created_at, n.id) > (s.created_at, s.id));

  DELETE FROM tint_staging_skus s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_skus n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.cod_produto = s.cod_produto AND n.id_base = s.id_base AND n.id_embalagem = s.id_embalagem
        AND (n.created_at, n.id) > (s.created_at, s.id));

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

  DELETE FROM tint_staging_formulas s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_formulas n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.cor_id = s.cor_id AND n.cod_produto = s.cod_produto AND n.id_base = s.id_base
        AND COALESCE(n.subcolecao, '') = COALESCE(s.subcolecao, '')
        AND n.personalizada = s.personalizada
        AND (n.created_at, n.id) > (s.created_at, s.id));

  DELETE FROM tint_staging_precos_base s
  WHERE s.created_at < now() - interval '30 days'
    AND EXISTS (SELECT 1 FROM tint_staging_precos_base n
      WHERE n.account = s.account AND n.store_code = s.store_code
        AND n.cod_produto = s.cod_produto AND n.id_base = s.id_base AND n.id_embalagem = s.id_embalagem
        AND (n.created_at, n.id) > (s.created_at, s.id));

  -- keys-snapshot: point-in-time (não latest-per-key) → purge por tempo é correto.
  DELETE FROM tint_keys_snapshots          WHERE created_at < now() - interval '30 days';

  UPDATE tint_sync_runs
    SET status = 'error', completed_at = COALESCE(completed_at, now())
  WHERE status = 'running' AND started_at < now() - interval '30 minutes';

  RETURN jsonb_build_object(
    'ok', true, 'promovidas', v_promovidas, 'recalculadas', v_recalc,
    'erros', v_erros, 'importacao_id', v_importacao_id);
END $$;
REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM anon, authenticated, PUBLIC;

SELECT 'tint_promote_sync_run SET-BASED OK' AS status;
