-- 20260611190000_tint_sync_codex_fixes.sql
-- Correções server-side do sync SayerSystem após revisão adversária do codex (retroativa).
-- Aplica DEPOIS de 20260609150000_tint_sync_promote.sql (que JÁ está em prod) — CREATE OR REPLACE
-- dos corpos completos (verbatim da 20260609150000) + os fixes abaixo. Migration manual (SQL Editor).
--
-- Fixes:
--   S1 (codex P1-7) — advisory lock por (account+store) no INÍCIO de tint_promote_sync_run E
--     tint_apply_keys_snapshot: duas promoções concorrentes do mesmo par interleavam a leitura/escrita
--     do latest-staging (o mais VELHO vencia). pg_advisory_xact_lock(hashtext('tint_sync:'||acc||':'||store))
--     serializa por transação (libera no commit/rollback).
--   S2 (codex P1-8) — vazamento cross-store: tint_calc_preco_final/tint_recalc_preco_oficial liam
--     tint_staging_precos_base/corantes SÓ por account → preço de uma loja podia usar insumo de outra
--     loja do mesmo account. +p_store_code nas DUAS funções + AND store_code = p_store_code em TODO
--     lookup de staging. ⚠️ Assinatura nova = NOVO overload (lista de args diferente) → DROP dos
--     overloads antigos (6/5 args) ANTES do CREATE.
--   S3 (codex P1-11) — latest NÃO-NULO do insumo: o lookup pegava a linha mais recente cega; um
--     update só-de-descrição (linha nova com custo/volume NULL) regredia um preço conhecido p/ NULL.
--     Agora o lookup de precos_base pega a latest WHERE custo IS NOT NULL; o de corante, a latest
--     WHERE custo IS NOT NULL AND volume_ml IS NOT NULL.
--   S4 (codex P1-5) — chave-fonte de 4 partes no keys-snapshot: o conector v0.1.1 manda a chave
--     POR FÓRMULA-FONTE "cor_id|cod_produto|id_base|personalizada" (SEM embalagem — 1 fonte expande em
--     N embalagens vendáveis). _oficial_ativas deriva a MESMA chave de 4 partes; uma fórmula-fonte
--     oficial aparece N vezes (1 por embalagem) com a MESMA chave → blast radius conta chaves DISTINTAS;
--     a desativação marca TODAS as expansões cuja chave ∉ snapshot.
--
-- Oráculo TS espelhado (sem mudança de assinatura): src/lib/tint/sync-promote.ts (a seleção
-- latest-não-nulo do S3 acontece no lookup SQL, não no helper puro — o helper recebe o insumo já
-- resolvido). PG17: db/test-tint-promote.sh (aplica 20260609150000 → 20260611190000, como prod).

-- ════════════════════════════════════════════════════════════════════════════
-- S2 — DROP dos overloads ANTIGOS das funções de preço (assinatura sem store_code).
--      CREATE OR REPLACE com NOVA lista de args criaria um overload PARALELO; o antigo precisa sair.
-- ════════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.tint_calc_preco_final(text, text, text, text, uuid, numeric);
DROP FUNCTION IF EXISTS public.tint_recalc_preco_oficial(text, uuid, text, text, text);

-- ════════════════════════════════════════════════════════════════════════════
-- E) Promoção (latest-staging-por-chave; §6.2). SECURITY DEFINER, search_path fixo.
--    +S1 advisory lock no início; +S2 v_store nos call sites das funções de preço.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.tint_promote_sync_run(p_sync_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run            record;
  v_account        text;
  v_store          text;
  v_importacao_id  uuid;
  v_promovidas     int := 0;
  v_erros          int := 0;
  v_recalc         int := 0;
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

  -- ──────────────────────────────────────────────────────────────────────────
  -- E2/E3) Fórmulas: latest-staging por chave de fórmula + re-expansão por par afetado.
  --   O conjunto de pares (produto,base) a (re)expandir = pares com fórmula tocada NESTE run
  --   ∪ pares cujos skus o run criou/tocou (§11 P1-C: embalagem nova ⇒ re-expandir).
  --   Para cada par, pego a LATEST staging de cada (cor_id, COALESCE(subcolecao,''), personalizada)
  --   que tenha esse cod_produto/id_base — across TODOS os runs (não só este).
  -- ──────────────────────────────────────────────────────────────────────────

  -- Pares (cod_produto, id_base) afetados.
  CREATE TEMP TABLE _pares ON COMMIT DROP AS
  SELECT DISTINCT cod_produto, id_base FROM (
    SELECT cod_produto, id_base FROM tint_staging_formulas
      WHERE sync_run_id = p_sync_run_id AND cod_produto IS NOT NULL AND id_base IS NOT NULL
    UNION
    SELECT cod_produto, id_base FROM _tp_sku
  ) u;

  -- Latest staging de fórmula por (cod_produto, id_base, cor_id, sub_norm, personalizada),
  -- restrita aos pares afetados.
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

  FOR r IN SELECT * FROM _formulas_latest LOOP
    -- Resolve FKs do par.
    SELECT id INTO v_produto_id FROM tint_produtos WHERE account = v_account AND cod_produto = r.cod_produto;
    SELECT id INTO v_base_id    FROM tint_bases    WHERE account = v_account AND id_base_sayersystem = r.id_base;
    IF v_produto_id IS NULL OR v_base_id IS NULL THEN
      INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
      VALUES (p_sync_run_id, 'formula_promote', r.cor_id,
              'produto/base não resolvido (catálogo incompleto)',
              jsonb_build_object('cod_produto', r.cod_produto, 'id_base', r.id_base));
      v_erros := v_erros + 1;
      CONTINUE;
    END IF;

    -- Subcoleção: ensure se texto não-vazio.
    v_subcolecao_id := NULL;
    IF r.subcolecao IS NOT NULL AND btrim(r.subcolecao) <> '' THEN
      INSERT INTO tint_subcolecoes (account, id_subcolecao_sayersystem, descricao)
      VALUES (v_account, r.subcolecao, r.subcolecao)
      ON CONFLICT (account, id_subcolecao_sayersystem) DO NOTHING;
      SELECT id INTO v_subcolecao_id FROM tint_subcolecoes
      WHERE account = v_account AND id_subcolecao_sayersystem = r.subcolecao;
    END IF;

    -- Guarda: volume de formulação inválido → não promove (espelho expandirFormula).
    IF r.volume_final_ml IS NULL OR r.volume_final_ml <= 0 THEN
      INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
      VALUES (p_sync_run_id, 'formula_promote', r.cor_id,
              'volume de formulação <= 0 ou nulo',
              jsonb_build_object('volume_final_ml', r.volume_final_ml));
      v_erros := v_erros + 1;
      CONTINUE;
    END IF;

    -- Embalagens VENDÁVEIS do par (tint_skus). Zero vendáveis → não promove.
    SELECT count(*) INTO v_qtd_vendaveis
    FROM tint_skus sk
    JOIN tint_embalagens e ON e.id = sk.embalagem_id
    WHERE sk.account = v_account AND sk.produto_id = v_produto_id AND sk.base_id = v_base_id
      AND e.volume_ml IS NOT NULL AND e.volume_ml > 0;
    IF v_qtd_vendaveis = 0 THEN
      INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
      VALUES (p_sync_run_id, 'formula_promote', r.cor_id,
              'zero embalagens vendáveis para o par (produto,base)',
              jsonb_build_object('cod_produto', r.cod_produto, 'id_base', r.id_base));
      v_erros := v_erros + 1;
      CONTINUE;
    END IF;

    -- Expande por cada embalagem vendável (fator = vol_destino / vol_formulacao).
    FOR v_emb_id, v_fator IN
      SELECT sk.embalagem_id, (e.volume_ml / r.volume_final_ml)
      FROM tint_skus sk
      JOIN tint_embalagens e ON e.id = sk.embalagem_id
      WHERE sk.account = v_account AND sk.produto_id = v_produto_id AND sk.base_id = v_base_id
        AND e.volume_ml IS NOT NULL AND e.volume_ml > 0
    LOOP
      SELECT id INTO v_sku_id FROM tint_skus
      WHERE account = v_account AND produto_id = v_produto_id AND base_id = v_base_id AND embalagem_id = v_emb_id;

      -- Preço reproduzido (pág 9) p/ ESTA embalagem de destino (espelho precoFinalSayer).
      -- S2: +v_store (insumo da loja certa).
      v_preco := tint_calc_preco_final(
        v_account, v_store, r.cod_produto, r.id_base,
        (SELECT id_embalagem_sayersystem FROM tint_embalagens WHERE id = v_emb_id),
        r.staging_formula_id, v_fator);

      -- Upsert oficial por uq_tint_formulas_chave; desativada_em = NULL (reativa).
      INSERT INTO tint_formulas (
        account, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id, sku_id,
        volume_final_ml, preco_final_sayersystem, personalizada, importacao_id, updated_at, desativada_em
      ) VALUES (
        v_account, r.cor_id, r.nome_cor, v_produto_id, v_base_id, v_emb_id, v_subcolecao_id, v_sku_id,
        (SELECT volume_ml FROM tint_embalagens WHERE id = v_emb_id),
        v_preco, r.personalizada, v_importacao_id, now(), NULL
      )
      ON CONFLICT (account, cor_id, produto_id, base_id, COALESCE(subcolecao_id, '00000000-0000-0000-0000-000000000000'::uuid), embalagem_id)
      DO UPDATE SET
        nome_cor                = EXCLUDED.nome_cor,
        sku_id                  = EXCLUDED.sku_id,
        volume_final_ml         = EXCLUDED.volume_final_ml,
        preco_final_sayersystem = EXCLUDED.preco_final_sayersystem,
        personalizada           = EXCLUDED.personalizada,
        importacao_id           = EXCLUDED.importacao_id,
        updated_at              = now(),
        desativada_em           = NULL
      RETURNING id INTO v_formula_id;

      -- Itens delete+insert (corante stub se referenciado-ausente, como ensureCorante do CSV).
      -- qtd expandida = qtd_formulacao × fator (espelho expandirFormula). Arredonda a 6 casas
      -- (sub-µL, abaixo de qualquer tolerância de tintometria): elimina o artefato de escala da
      -- divisão numeric (ex.: 12.5 × (5000/900) = 69.44444444444444500) sem mudar o valor prático.
      DELETE FROM tint_formula_itens WHERE formula_id = v_formula_id;
      INSERT INTO tint_formula_itens (formula_id, corante_id, ordem, qtd_ml)
      SELECT v_formula_id, ic.corante_id, si.ordem, round((si.qtd_ml * v_fator)::numeric, 6)
      FROM tint_staging_formula_itens si
      JOIN LATERAL (
        SELECT tint_ensure_corante_stub(v_account, si.id_corante) AS corante_id
      ) ic ON true
      WHERE si.staging_formula_id = r.staging_formula_id
        AND si.id_corante IS NOT NULL AND si.id_corante <> '' AND COALESCE(si.qtd_ml, 0) > 0;

      v_promovidas := v_promovidas + 1;
    END LOOP;
  END LOOP;

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
    UPDATE tint_formulas SET preco_final_sayersystem = v_preco, updated_at = now() WHERE id = r.formula_id;
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
    UPDATE tint_formulas SET preco_final_sayersystem = v_preco, updated_at = now() WHERE id = r.formula_id;
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

-- ════════════════════════════════════════════════════════════════════════════
-- E-helpers (preço pág 9, espelho VERBATIM de precoFinalSayer). SECURITY DEFINER.
--   +S2 p_store_code em TODO lookup de staging; +S3 latest NÃO-NULO do insumo.
-- ════════════════════════════════════════════════════════════════════════════

-- Preço de uma fórmula promovida (na expansão): usa os itens JÁ EXPANDIDOS implicitamente
-- via (itens da formulação × fator) — recebe o fator e a staging_formula_id de origem.
-- Espelho precoFinalSayer: base×(1+imp/100)×(1+marg/100) + Σ(qtd_exp × custo_cor/vol_cor).
-- Insumo faltando → NULL (nunca 0); custo_base=0 é VÁLIDO; corante usado sem preço/vol → NULL.
-- S3: lookup pega a latest com custo NÃO-NULO (precos_base) / custo+volume NÃO-NULOS (corante)
--     → update só-de-descrição (linha nova com NULL) não regride preço bom p/ NULL.
CREATE OR REPLACE FUNCTION public.tint_calc_preco_final(
  p_account text, p_store_code text, p_cod_produto text, p_id_base text, p_id_embalagem text,
  p_staging_formula_id uuid, p_fator numeric)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_base       record;
  v_preco_base numeric;
  v_soma       numeric := 0;
  it           record;
  v_cor        record;
BEGIN
  -- Insumo da base p/ ESTA embalagem de destino (latest staging precos_base COM custo).
  -- S2: AND store_code = p_store_code. S3: AND custo IS NOT NULL.
  SELECT custo, imposto_pct, margem_pct INTO v_base
  FROM tint_staging_precos_base
  WHERE account = p_account AND store_code = p_store_code
    AND cod_produto = p_cod_produto AND id_base = p_id_base AND id_embalagem = p_id_embalagem
    AND custo IS NOT NULL
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  -- base ausente OU custo não-finito → NULL (espelho: base==null || !isFinite(custo)).
  IF v_base IS NULL OR v_base.custo IS NULL OR NOT (v_base.custo > '-Infinity'::numeric AND v_base.custo < 'Infinity'::numeric) THEN
    RETURN NULL;
  END IF;
  v_preco_base := v_base.custo
                  * (1 + COALESCE(v_base.imposto_pct, 0) / 100)
                  * (1 + COALESCE(v_base.margem_pct, 0) / 100);

  -- Σ corantes: itens da formulação × fator; cada corante precisa de custo finito + volume>0.
  FOR it IN
    SELECT id_corante, (qtd_ml * p_fator) AS qtd_exp
    FROM tint_staging_formula_itens
    WHERE staging_formula_id = p_staging_formula_id
      AND id_corante IS NOT NULL AND id_corante <> '' AND COALESCE(qtd_ml, 0) > 0
  LOOP
    -- S2: AND store_code = p_store_code. S3: AND custo IS NOT NULL AND volume_ml IS NOT NULL.
    SELECT custo, volume_ml INTO v_cor
    FROM tint_staging_corantes
    WHERE account = p_account AND store_code = p_store_code AND id_corante_sayersystem = it.id_corante
      AND custo IS NOT NULL AND volume_ml IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
    IF v_cor IS NULL OR v_cor.custo IS NULL
       OR NOT (v_cor.custo > '-Infinity'::numeric AND v_cor.custo < 'Infinity'::numeric)
       OR v_cor.volume_ml IS NULL OR v_cor.volume_ml <= 0 THEN
      RETURN NULL;
    END IF;
    v_soma := v_soma + (v_cor.custo / v_cor.volume_ml) * it.qtd_exp;
  END LOOP;

  RETURN round((v_preco_base + v_soma)::numeric, 2);
END $$;
REVOKE EXECUTE ON FUNCTION public.tint_calc_preco_final(text, text, text, text, text, uuid, numeric) FROM anon, authenticated, PUBLIC;

-- Recálculo de preço de uma fórmula OFICIAL já promovida (E4): usa os itens oficiais
-- (tint_formula_itens, já expandidos) × insumos do staging mais recente. Espelho precoFinalSayer.
-- S2: +p_store_code. S3: latest NÃO-NULO do insumo (precos_base com custo; corante com custo+volume).
CREATE OR REPLACE FUNCTION public.tint_recalc_preco_oficial(
  p_account text, p_store_code text, p_formula_id uuid, p_cod_produto text, p_id_base text, p_id_embalagem text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_base       record;
  v_preco_base numeric;
  v_soma       numeric := 0;
  it           record;
  v_cor        record;
BEGIN
  -- S2: AND store_code = p_store_code. S3: AND custo IS NOT NULL.
  SELECT custo, imposto_pct, margem_pct INTO v_base
  FROM tint_staging_precos_base
  WHERE account = p_account AND store_code = p_store_code
    AND cod_produto = p_cod_produto AND id_base = p_id_base AND id_embalagem = p_id_embalagem
    AND custo IS NOT NULL
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_base IS NULL OR v_base.custo IS NULL OR NOT (v_base.custo > '-Infinity'::numeric AND v_base.custo < 'Infinity'::numeric) THEN
    RETURN NULL;
  END IF;
  v_preco_base := v_base.custo
                  * (1 + COALESCE(v_base.imposto_pct, 0) / 100)
                  * (1 + COALESCE(v_base.margem_pct, 0) / 100);

  FOR it IN
    SELECT co.id_corante_sayersystem AS id_corante, fi.qtd_ml AS qtd_exp
    FROM tint_formula_itens fi
    JOIN tint_corantes co ON co.id = fi.corante_id
    WHERE fi.formula_id = p_formula_id AND COALESCE(fi.qtd_ml, 0) > 0
  LOOP
    -- S2: AND store_code = p_store_code. S3: AND custo IS NOT NULL AND volume_ml IS NOT NULL.
    SELECT custo, volume_ml INTO v_cor
    FROM tint_staging_corantes
    WHERE account = p_account AND store_code = p_store_code AND id_corante_sayersystem = it.id_corante
      AND custo IS NOT NULL AND volume_ml IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
    IF v_cor IS NULL OR v_cor.custo IS NULL
       OR NOT (v_cor.custo > '-Infinity'::numeric AND v_cor.custo < 'Infinity'::numeric)
       OR v_cor.volume_ml IS NULL OR v_cor.volume_ml <= 0 THEN
      RETURN NULL;
    END IF;
    v_soma := v_soma + (v_cor.custo / v_cor.volume_ml) * it.qtd_exp;
  END LOOP;

  RETURN round((v_preco_base + v_soma)::numeric, 2);
END $$;
REVOKE EXECUTE ON FUNCTION public.tint_recalc_preco_oficial(text, text, uuid, text, text, text) FROM anon, authenticated, PUBLIC;

-- ════════════════════════════════════════════════════════════════════════════
-- F) Aplicação do keys-snapshot com guardas (§11 P1-B; espelho de validarSnapshotKeys).
--    +S1 advisory lock; +S4 chave-fonte de 4 partes (sem embalagem) + counts DISTINCT.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.tint_apply_keys_snapshot(p_snapshot_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_meta        record;
  v_chunks_recv int;
  v_account     text;
  v_store       text;
  v_setting_id  uuid;
  v_generated   timestamptz;
  v_total_chunks int;
  v_last_applied timestamptz;
  v_total_ativas int;
  v_chaves_snap  int;
  v_desativariam int;
  v_run_id       uuid;
BEGIN
  -- Metadados do snapshot (entity 'formulas' v1).
  SELECT account, store_code, setting_id, generated_at, total_chunks
    INTO v_account, v_store, v_setting_id, v_generated, v_total_chunks
  FROM tint_keys_snapshots
  WHERE snapshot_id = p_snapshot_id AND entity = 'formulas'
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  IF v_account IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'snapshot inexistente');
  END IF;

  -- S1 (codex P1-7): serializa com a promoção do mesmo (account+store) — a desativação lê o oficial
  -- ATIVO e a promoção o reescreve. Mesma chave de lock que tint_promote_sync_run.
  PERFORM pg_advisory_xact_lock(hashtext('tint_sync:' || v_account || ':' || v_store));

  -- Para registrar erros precisamos de um sync_run (sync_run_id é NOT NULL em tint_sync_errors).
  INSERT INTO tint_sync_runs (setting_id, account, store_code, sync_type, status, source)
  VALUES (v_setting_id, v_account, v_store, 'keys_snapshot', 'running', 'agent')
  RETURNING id INTO v_run_id;

  -- 1) Snapshot COMPLETO? (count distinct chunk_index == total_chunks)
  SELECT count(DISTINCT chunk_index) INTO v_chunks_recv
  FROM tint_keys_snapshots WHERE snapshot_id = p_snapshot_id AND entity = 'formulas';
  IF v_chunks_recv <> v_total_chunks THEN
    INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
    VALUES (v_run_id, 'keys_snapshot', p_snapshot_id::text, 'chunks incompletos',
            jsonb_build_object('recebidos', v_chunks_recv, 'esperados', v_total_chunks));
    UPDATE tint_sync_runs SET status='error', completed_at=now() WHERE id=v_run_id;
    RETURN jsonb_build_object('ok', false, 'error', 'chunks incompletos', 'recebidos', v_chunks_recv, 'esperados', v_total_chunks);
  END IF;

  -- 2) Fora de ordem? (generated_at <= último aplicado)
  SELECT last_keys_snapshot_at INTO v_last_applied FROM tint_integration_settings WHERE id = v_setting_id;
  IF v_last_applied IS NOT NULL AND v_generated <= v_last_applied THEN
    UPDATE tint_sync_runs SET status='complete', completed_at=now(),
      metadata = jsonb_build_object('skipped', 'fora de ordem') WHERE id=v_run_id;
    RETURN jsonb_build_object('ok', true, 'skipped', 'snapshot fora de ordem', 'generated_at', v_generated);
  END IF;

  -- Conjunto de chaves do snapshot (montado de todos os chunks).
  CREATE TEMP TABLE _snap_keys ON COMMIT DROP AS
  SELECT DISTINCT chave
  FROM tint_keys_snapshots, jsonb_array_elements_text(keys) AS chave
  WHERE snapshot_id = p_snapshot_id AND entity = 'formulas';

  -- S4: chave-fonte de 4 PARTES = cor_id|cod_produto|id_base|personalizada (SEM embalagem; ids SAYER,
  -- via joins). O conector v0.1.1 manda 1 chave por fórmula-FONTE; o servidor expande a fonte em N
  -- embalagens vendáveis → a chave por-embalagem nunca casaria (deleção abortava por blast radius).
  -- Uma fórmula-fonte oficial aparece N vezes (1 por embalagem) com a MESMA chave; mantemos f.id por
  -- linha (p/ a desativação marcar TODAS as expansões), mas os counts são sobre chaves DISTINTAS.
  CREATE TEMP TABLE _oficial_ativas ON COMMIT DROP AS
  SELECT f.id,
         (f.cor_id || '|' || p.cod_produto || '|' || b.id_base_sayersystem || '|'
          || (CASE WHEN f.personalizada THEN 'true' ELSE 'false' END)) AS chave
  FROM tint_formulas f
  JOIN tint_produtos   p ON p.id = f.produto_id
  JOIN tint_bases      b ON b.id = f.base_id
  WHERE f.account = v_account AND f.desativada_em IS NULL;

  -- Blast radius sobre chaves DISTINTAS (1 fonte = 1 chave, não N embalagens).
  SELECT count(DISTINCT chave) INTO v_total_ativas FROM _oficial_ativas;
  SELECT count(*)              INTO v_chaves_snap  FROM _snap_keys;
  SELECT count(DISTINCT o.chave) INTO v_desativariam FROM _oficial_ativas o
    WHERE NOT EXISTS (SELECT 1 FROM _snap_keys s WHERE s.chave = o.chave);

  -- 3) Blast radius (espelho validarSnapshotKeys). Oficial vazio = primeira carga → ok.
  IF v_total_ativas > 0 THEN
    IF v_chaves_snap < v_total_ativas * 0.5 THEN
      INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
      VALUES (v_run_id, 'keys_snapshot', p_snapshot_id::text,
              'blast radius: snapshot menor que 50% do oficial ativo (provável chunk perdido)',
              jsonb_build_object('chaves_snapshot', v_chaves_snap, 'oficial_ativas', v_total_ativas));
      UPDATE tint_sync_runs SET status='error', completed_at=now() WHERE id=v_run_id;
      RETURN jsonb_build_object('ok', false, 'error', 'blast radius: snapshot < 50% do oficial ativo',
        'chaves_snapshot', v_chaves_snap, 'oficial_ativas', v_total_ativas);
    END IF;
    IF v_desativariam > v_total_ativas * 0.2 THEN
      INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
      VALUES (v_run_id, 'keys_snapshot', p_snapshot_id::text,
              'blast radius: desativaria >20% das fórmulas ativas',
              jsonb_build_object('desativariam', v_desativariam, 'oficial_ativas', v_total_ativas));
      UPDATE tint_sync_runs SET status='error', completed_at=now() WHERE id=v_run_id;
      RETURN jsonb_build_object('ok', false, 'error', 'blast radius: desativaria >20% das fórmulas ativas',
        'desativariam', v_desativariam, 'oficial_ativas', v_total_ativas);
    END IF;
  END IF;

  -- 4) Desativa (soft) TODAS as expansões cuja CHAVE-FONTE está fora do snapshot.
  --    (Reativação é responsabilidade da promoção.)
  UPDATE tint_formulas SET desativada_em = now(), updated_at = now()
  WHERE id IN (
    SELECT o.id FROM _oficial_ativas o
    WHERE NOT EXISTS (SELECT 1 FROM _snap_keys s WHERE s.chave = o.chave)
  );

  -- 5) Avança o marcador de ordem + fecha o run. deletes/desativadas = chaves DISTINTAS desativadas.
  UPDATE tint_integration_settings SET last_keys_snapshot_at = v_generated, updated_at = now()
  WHERE id = v_setting_id;
  UPDATE tint_sync_runs
    SET status='complete', completed_at=now(), deletes = v_desativariam,
        metadata = jsonb_build_object('desativadas', v_desativariam, 'oficial_ativas', v_total_ativas, 'chaves_snapshot', v_chaves_snap)
  WHERE id = v_run_id;

  RETURN jsonb_build_object('ok', true, 'desativadas', v_desativariam,
    'oficial_ativas', v_total_ativas, 'chaves_snapshot', v_chaves_snap);
END $$;
REVOKE EXECUTE ON FUNCTION public.tint_apply_keys_snapshot(uuid) FROM anon, authenticated, PUBLIC;
