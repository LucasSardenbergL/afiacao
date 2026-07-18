-- 20260718100000_tint_promote_guard4_hardening.sql
-- FASE 1 (P0) money-path — HARDENING do Guard 4. SUPERSEDE a 20260717163000 (mesma sessão): este corpo é
-- AUTO-SUFICIENTE (CREATE OR REPLACE completo, a última a recriar VENCE) → aplicar SÓ ESTA já basta; se a
-- 20260717163000 tiver sido aplicada antes, esta a corrige por cima. Fecha 5 bypasses P1 achados pelo Codex
-- (gpt-5.6-sol xhigh) no diff da v1 — a v1 fechava o caso original mas só em staging estável e sem colisão:
--   P1-1 CORRIDA: _formulas_latest lia header de run AINDA EM INGESTÃO (o edge commita headers ANTES dos
--        itens; o advisory lock serializa a PROMOÇÃO, não a ingestão) → o guard via "0 corantes", tratava
--        como base pura, promovia e APAGAVA a receita oficial. Fix: só considera run status='complete'.
--   P1-2 CLEANUP FALHO: item falha → o edge tenta apagar os headers e IGNORA o erro, marca 'complete' e
--        promove → header sem itens substituía a receita. Fix: defesa em profundidade no DELETE (abaixo).
--   P1-3 ITEM ÓRFÃO COM DOSE: id_corante='' + qtd_ml>0 (o edge converte ID ausente em '' PRESERVANDO a
--        dose) — o guard ignorava e o writer filtrava → a dose sumia = receita incompleta. Fix: dose
--        positiva sem corante identificado agora CORROMPE a fórmula.
--   P1-4 COLISÃO DE CHAVE OFICIAL: o guard removia o candidato corrompido ANTES do _expand_uniq → o
--        PERDEDOR virava vencedor e substituía header/preço/receita. Fix: o vencedor é escolhido PRIMEIRO
--        e o guard é aplicado DEPOIS — se o vencedor está corrompido, a chave oficial INTEIRA é omitida.
--   P1-5 DOSE NÃO-FINITA: em numeric, NaN <= 0 é FALSO e NaN > 0 é VERDADEIRO → NaN/Infinity passavam pelo
--        guard E entravam na receita. Fix: predicado ÚNICO de "dose válida" (positiva E finita), reusado
--        no guard, no itens_dedup do preço, no stub de corante e no INSERT de itens.
-- Provado: db/test-tint-promote.sh C14-C20 + falsificação. SQL Editor (§deploy.md).
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- [HERDADO da 20260717163000_tint_promote_fail_closed_receita_parcial.sql:]
-- FASE 1 (P0) money-path — fronteira de ESCRITA fail-closed por-linha (writer VIVO tint_promote_sync_run).
-- DEFEITO: o INSERT de tint_formula_itens filtra o slot ruim (WHERE id_corante<>'' AND qtd_ml>0) enquanto
-- o DELETE...USING _promoted apaga a receita anterior INCONDICIONALMENTE → uma fórmula do staging com um
-- corante PRESENTE mas sem dose válida (qtd_ml NULL/≤0) gravava receita PARCIAL (subfaturamento silencioso
-- via get_tint_price/bool_and sobre os corantes presentes — preço baixo VÁLIDO) ou ZERO. Fail-OPEN.
-- Inocentado p/ as 28.609 vazias de março (vieram do CSV, importacao_id NULL, o promote nem existia), mas
-- carrega o MESMO defeito no dado NOVO/vivo (geração SL desde 18/06). Ver docs/agent/tintometrico.md §Import.
-- FIX (Guard 4 — ALL-OR-NOTHING por fórmula): se a fórmula LATEST do staging tem ≥1 corante presente cujo
-- conjunto de linhas NÃO tem NENHUMA dose válida, a fórmula NÃO é promovida — fica FORA do _expand → fora
-- de _promoted → o DELETE de itens não a toca → a RECEITA ANTERIOR é 100% preservada, e o erro vai a
-- tint_sync_errors (entity_type='formula_promote'). Distingue "fórmula legitimamente sem corante" (base
-- pura, nenhum corante presente → NÃO dispara) e "dosagem em 2 etapas" (mesmo corante em 2 ordens ambas
-- >0, 20260622210000 → o corante TEM dose válida → NÃO dispara). Precisão>recall; ausente≠zero; nunca
-- gravar número parcial. Plano: docs/superpowers/plans/2026-07-17-tint-receita-perdida-remediacao.md Fase 1a.
-- CREATE OR REPLACE — a ÚLTIMA a recriar VENCE: este corpo é VERBATIM da 20260622210000 (pré-flight
-- pg_get_functiondef da PROD 2026-07-17 = SEM deriva, 563 linhas idênticas) + o Guard 4 + o filtro no
-- _expand. Preserva TODA a cadeia de fixes (advisory lock · latest-per-key · _skus_novos · COALESCE preço
-- · E4 só-custo · nome_cor fallback · dedup itens). Provado: db/test-tint-promote.sh (C14-C16 +
-- falsificação) + Codex xhigh no diff. SQL Editor (§deploy.md) — Lovable NÃO auto-aplica nome custom.
--
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════
-- [HERDADO — corpo consolidado VERBATIM de 20260622210000_tint_promote_dedup_itens_corante.sql abaixo:]
-- MUDANÇA money-path (estanca RE-LOOP): a promoção DEDUPLICA itens por (formula_id, corante_id) no
-- INSERT de tint_formula_itens. Revelado 22/06 investigando re-envio residual (~75k re-stagings/dia em
-- batches CHEIOS de 1000): 4 cores PADRÃO ATIVAS (344M/629N/638S/997M - BS) têm o MESMO corante em 2
-- slots (dosagem em 2 etapas). O conector manda 2 itens; o INSERT SEM dedup viola o unique
-- tint_formula_itens_formula_id_corante_id_key (23505) → ROLLBACK do batch → a edge devolve 500 → o
-- conector não cacheia o lote → re-envia o batch CHEIO p/ sempre. Como a promoção usa latest-per-key
-- restrito aos PARES tocados, essas 4 cores envenenam TODO batch que toca seus pares (18 prod/51 bases
-- ≈ 1000 fórmulas reféns, re-staged 41×/dia). lock timeout (55P03) era colateral da contention → cessa
-- junto. Fix: DISTINCT ON (formula_id, corante_id) ORDER BY ordem DESC = MAIOR ORDEM VENCE — idêntico
-- ao oficial CSV-import (prod: 344M c1=ordem3=1.54, 997M c3=ordem5=14.09) → IDEMPOTENTE, zero mudança
-- de dosagem. CREATE OR REPLACE — a última vence; inclui tudo da cadeia. PG17
-- db/test-tint-promote-dedup-itens.sh + Codex. SQL Editor (§deploy.md).
--
-- [HERDADO da 20260622130000_tint_promote_nome_cor_fallback.sql:]
-- MUDANÇA money-path (ROBUSTEZ): a promoção tolera nome_cor VAZIO. Revelado 22/06 pela prova de
-- tempo-real: cor PERSONALIZADA nova (TESTE CLAUDE, conta oben) chegou com nome_cor NULL (o conector
-- não resolveu o lookup CorPerson p/ a personcor) → o INSERT em tint_formulas violava a constraint
-- NOT NULL de nome_cor (23502) e derrubava o RUN INTEIRO (rollback; padrão OK, mas a personalizada
-- nunca entrava). Fix: no _formulas_latest, nome_cor = COALESCE(NULLIF(btrim(nome_cor),''), cor_id) —
-- stub p/ o código quando vazio (espelha o stub de corante). O nome real entra no próximo upsert
-- quando o conector for corrigido (mandar o nome + incluí-lo no hash). INCLUI tudo das migrations
-- anteriores (_skus_novos + COALESCE preço + E4 custo). CREATE OR REPLACE — a última vence. PG17 + Codex.
--
-- [HERDADO da 20260618130000_tint_promote_e4_so_com_custo.sql:]
-- MUDANÇA money-path (CARGA, parte 2): o E4 (recálculo de preço por corante) só dispara quando há
-- CUSTO no staging_corantes. Incidente 18/06 (no 2º re-flip): o re-envio promoveu 94% das fórmulas
-- (E2/E3 + COALESCE OK em prod), mas o run de CORANTES travou — a condição antiga
-- (custo IS NOT NULL OR volume_ml IS NOT NULL) disparava por volume_ml (sempre presente) e recalculava
-- ~481k fórmulas por corante, uma a uma, num único run → gateway timeout → advisory lock preso →
-- cascata 55P03. O SayerSystem NÃO manda custo (§14, preço vem do Omie) → sem custo o recálculo dá
-- NULL e o COALESCE preserva o piso: era carga 100% inútil. Fix: condição vira só `custo IS NOT NULL`.
-- INCLUI tudo da 20260617150000 (re-expansão só skus novos) + da 130000 (COALESCE preço). CREATE OR
-- REPLACE — a última a recriar vence. Provado em PG17 + Codex.
--
-- [HERDADO da 20260617150000_tint_promote_reexpand_skus_novos.sql:]
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
    -- P1-1 CORRIDA (Codex xhigh): SÓ considera header de run FINALIZADO. O tint-sync-agent insere os
    -- headers (chunks de 500) ANTES dos itens (chunks de 1000) e só então marca o run 'complete' e chama
    -- esta RPC; o pg_advisory_xact_lock serializa as PROMOÇÕES, NÃO a ingestão. Sem este filtro, o run A
    -- promovia lendo o header recém-commitado do run B cujos itens ainda não chegaram → o Guard 4 via
    -- "0 corantes presentes", tratava como BASE PURA, promovia, e o DELETE...USING _promoted APAGAVA a
    -- receita oficial (zero/parcial) — bypass direto do fail-closed. Com o filtro, staging em voo é
    -- invisível até o run fechar. Também é fail-closed p/ run 'error' (staging de run que falhou não
    -- promove) e p/ o run órfão >30min que o E5 marca 'error'.
    -- ⚠️ alias `sr` (NÃO `r`): `r` é uma VARIÁVEL record declarada nesta função (usada nos FOR loops de
    -- E1/E4). Em plpgsql o identificador da variável VENCE o alias da tabela, então `JOIN ... r ON r.id`
    -- compila e só explode em RUNTIME com `record "r" has no field "id"` (late-bound). Pego pelo PG17.
    JOIN tint_sync_runs sr ON sr.id = s.sync_run_id AND sr.status = 'complete'
    WHERE s.account = v_account AND s.store_code = v_store
      AND s.cor_id IS NOT NULL AND s.cod_produto IS NOT NULL AND s.id_base IS NOT NULL
  )
  SELECT DISTINCT ON (cor_id, cod_produto, id_base, COALESCE(subcolecao, ''), personalizada)
         id AS staging_formula_id, cor_id,
         -- 20260622 (fix nome_cor NULL): nome de cor PERSONALIZADA pode vir VAZIO do conector (lookup
         -- CorPerson não resolveu) → a constraint NOT NULL de tint_formulas.nome_cor derrubava o RUN
         -- INTEIRO (23502). Fallback p/ cor_id (stub, espelha o corante stub). Nunca abortar a promoção
         -- por um campo de DISPLAY ausente; o nome real entra no próximo upsert quando o conector resolver.
         -- Codex 22/06: CASE (não COALESCE+btrim) p/ NÃO trimar nome legítimo com espaço — só
         -- substitui quando NULL/vazio, preservando o nome_cor original VERBATIM.
         CASE WHEN nome_cor IS NULL OR btrim(nome_cor) = '' THEN cor_id ELSE nome_cor END AS nome_cor,
         cod_produto, id_base, id_embalagem,
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

  -- ══════════════════════════════════════════════════════════════════════════
  -- Guard 4 (FASE 1 money-path — fail-closed por-linha, RECEITA CORROMPIDA) — ALL-OR-NOTHING por fórmula.
  --   Um corante PRESENTE (id_corante não-vazio) cujo conjunto de linhas NÃO tem NENHUMA dose válida
  --   (bool_and(COALESCE(qtd_ml,0) <= 0)) seria FILTRADO pelo INSERT de tint_formula_itens
  --   (WHERE id_corante<>'' AND qtd_ml>0) → a fórmula gravaria receita PARCIAL (subfaturamento silencioso:
  --   get_tint_price/bool_and sobre os corantes PRESENTES pode devolver preço BAIXO válido) ou ZERO.
  --   Fail-OPEN. AQUI a fórmula inteira NÃO é promovida (o NOT EXISTS no _expand a remove) → fora de
  --   _promoted → o DELETE...USING _promoted não a toca → a RECEITA ANTERIOR é 100% preservada; o erro
  --   vai a tint_sync_errors. bool_and POR (formula,corante) — não "≥1 linha ruim" — para NÃO barrar a
  --   dosagem em 2 etapas legítima (mesmo corante em 2 ordens ambas >0, 20260622210000): ali o corante
  --   TEM dose válida → NÃO dispara. Base pura (todos os slots com id_corante vazio) → nenhum corante
  --   presente → NÃO dispara. Money-path: precisão>recall, ausente≠zero, nunca gravar número parcial.
  -- PREDICADO ÚNICO de DOSE VÁLIDA (P1-5, Codex xhigh) — positiva E FINITA:
  --     COALESCE(qtd_ml > 0 AND qtd_ml < 'Infinity'::numeric, false)
  -- Em `numeric` o NaN é ordenado ACIMA de tudo: `NaN <= 0` é FALSO e `NaN > 0` é VERDADEIRO — então o
  -- critério antigo (`COALESCE(qtd_ml,0) <= 0`) dava NaN como "dose válida" no guard, e o INSERT
  -- (`COALESCE(qtd_ml,0) > 0`) TAMBÉM o aceitava → NaN/Infinity entravam na receita e contaminavam
  -- preço/cálculo. `qtd_ml < 'Infinity'` derruba NaN e +Inf; `qtd_ml > 0` derruba -Inf, zero e negativo;
  -- o COALESCE derruba NULL. Este MESMO predicado é reusado no itens_dedup (preço), no stub de corante e
  -- no INSERT de itens — "dose válida" tem UMA definição só na função inteira (era a recomendação do Codex).
  CREATE TEMP TABLE _fl_corrompida ON COMMIT DROP AS
  SELECT DISTINCT staging_formula_id FROM (
    -- (a) corante PRESENTE cujo conjunto de linhas não tem NENHUMA dose válida → o INSERT filtraria esse
    --     corante → receita PARCIAL (subfaturamento silencioso) ou ZERO. bool_and POR (formula,corante)
    --     preserva a dosagem em 2 etapas legítima (mesmo corante em 2 ordens, ambas válidas).
    SELECT si.staging_formula_id
    FROM tint_staging_formula_itens si
    JOIN _fl_resolved fl ON fl.staging_formula_id = si.staging_formula_id
    WHERE fl.produto_id IS NOT NULL AND fl.base_id IS NOT NULL
      AND fl.volume_final_ml IS NOT NULL AND fl.volume_final_ml > 0
      AND btrim(COALESCE(si.id_corante, '')) <> ''
    GROUP BY si.staging_formula_id, si.id_corante
    HAVING bool_and(NOT COALESCE(si.qtd_ml > 0 AND si.qtd_ml < 'Infinity'::numeric, false))
    UNION ALL
    -- (b) P1-3 ITEM ÓRFÃO (Codex xhigh): dose VÁLIDA sem corante identificado (id_corante vazio/só-espaços).
    --     O edge converte ID ausente em '' PRESERVANDO a dose (tint-sync-agent :506) — o guard antigo
    --     ignorava a linha e o writer também a filtrava, então a dose SUMIA: sozinha, o DELETE zerava a
    --     receita e gravava header vazio; junto de itens válidos, gravava PARCIAL. Uma dose positiva é a
    --     prova de que a fórmula TEM esse componente — não conseguir identificá-lo é corrupção, não
    --     "ausência legítima". Placeholder vazio com dose zero/nula segue inócuo (base pura de verdade).
    SELECT si.staging_formula_id
    FROM tint_staging_formula_itens si
    JOIN _fl_resolved fl ON fl.staging_formula_id = si.staging_formula_id
    WHERE fl.produto_id IS NOT NULL AND fl.base_id IS NOT NULL
      AND fl.volume_final_ml IS NOT NULL AND fl.volume_final_ml > 0
      AND btrim(COALESCE(si.id_corante, '')) = ''
      AND COALESCE(si.qtd_ml > 0 AND si.qtd_ml < 'Infinity'::numeric, false)
  ) q;

  -- Loga UMA linha de erro por fórmula corrompida (espelha os guards 1-3; entity_id = cor_id).
  INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
  SELECT p_sync_run_id, 'formula_promote', fl.cor_id,
         'receita corrompida: corante presente sem dose válida, ou dose válida sem corante identificado — fórmula NÃO promovida, receita anterior preservada',
         jsonb_build_object(
           'cod_produto', fl.cod_produto, 'id_base', fl.id_base,
           -- TODOS os itens do staging (inclusive os de corante vazio) — o órfão com dose é uma das
           -- famílias de corrupção, esconder a linha esconderia o diagnóstico.
           'itens', (
             SELECT jsonb_agg(jsonb_build_object('id_corante', si.id_corante, 'ordem', si.ordem, 'qtd_ml', si.qtd_ml) ORDER BY si.ordem)
             FROM tint_staging_formula_itens si
             WHERE si.staging_formula_id = fl.staging_formula_id
           ))
  FROM _fl_resolved fl
  JOIN _fl_corrompida c ON c.staging_formula_id = fl.staging_formula_id;
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
  -- P1-4 (Codex xhigh): o Guard 4 deliberadamente NÃO filtra AQUI. Vários candidatos de _formulas_latest
  -- (separados por subcoleção crua/personalizada) podem COLAPSAR na mesma chave oficial; remover o
  -- candidato corrompido ANTES do _expand_uniq fazia o PERDEDOR da colisão virar vencedor e substituir
  -- header/preço/receita da chave oficial (podendo até reativá-la) em vez de PRESERVAR o oficial.
  -- O filtro foi movido p/ DEPOIS da escolha do vencedor — ver o DELETE em _expand_uniq abaixo.

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
  -- 20260622210000 (Codex P1 — consistência item↔preço): deduplica os itens por
  -- (staging_formula_id, id_corante) = MAX-ordem, IGUAL ao INSERT de tint_formula_itens. Senão o preço
  -- somaria o corante repetido (BOM "todos os itens") enquanto o item ARMAZENADO guarda só o max-ordem
  -- (BOM "1 por corante") — duas definições de fórmula na mesma promoção. Hoje é dead-code em prod
  -- (precos_base vazio → soma NULL → COALESCE preserva o piso), mas alinha os 2 caminhos para o dia em
  -- que precos_base for populado. Mesma ordem de desempate do INSERT de itens.
  itens_dedup AS (
    -- P1-5: MESMO predicado de dose válida do guard/stub/INSERT (positiva E finita) — sem isto o preço
    -- somaria um item NaN/Infinity que o guard já considera inválido (duas definições de fórmula).
    SELECT DISTINCT ON (staging_formula_id, id_corante) staging_formula_id, id_corante, qtd_ml
      FROM tint_staging_formula_itens
     WHERE btrim(COALESCE(id_corante, '')) <> ''
       AND COALESCE(qtd_ml > 0 AND qtd_ml < 'Infinity'::numeric, false)
     ORDER BY staging_formula_id, id_corante, ordem DESC, qtd_ml DESC, id DESC
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
    JOIN itens_dedup si ON si.staging_formula_id = ex.staging_formula_id
    LEFT JOIN cor_latest cl ON cl.id_corante_sayersystem = si.id_corante
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

  -- ══════════════════════════════════════════════════════════════════════════
  -- GUARD 4 APLICADO AQUI (P1-4, Codex xhigh) — DEPOIS de o vencedor da chave oficial estar escolhido.
  -- Se o VENCEDOR está corrompido, a chave oficial INTEIRA sai: sem fallback pro perdedor da colisão.
  -- Consequência (a que queremos): aquela `tint_formulas` não entra em _promoted → não sofre o upsert de
  -- header NEM o DELETE de itens → header (preço, importacao_id, desativada_em) E receita ficam INTACTOS.
  DELETE FROM _expand_uniq eu
  USING _fl_corrompida c
  WHERE c.staging_formula_id = eu.staging_formula_id;

  -- v_promovidas conta o que REALMENTE será gravado (linhas oficiais upsertadas), não as expansões
  -- pré-dedup. Antes contava _expand — com o guard movido pra cá, isso reportaria como "promovida" uma
  -- fórmula que o guard barrou: número fabricado num contador money-path (registros_importados /
  -- tint_sync_runs.inserts). Ausente ≠ zero, e "promovida" tem de significar promovida.
  SELECT count(*) INTO v_promovidas FROM _expand_uniq;

  -- Corante stubs em massa ANTES dos itens (espelha tint_ensure_corante_stub: volume 1000).
  -- A partir de _expand_uniq (pós-guard) — NÃO materializa corante de fórmula barrada. Predicado de
  -- dose válida idêntico ao do guard/INSERT (P1-5: NaN/Infinity fora).
  INSERT INTO tint_corantes (account, id_corante_sayersystem, descricao, volume_total_ml)
  SELECT DISTINCT v_account, si.id_corante, si.id_corante, 1000
  FROM tint_staging_formula_itens si
  WHERE si.staging_formula_id IN (SELECT DISTINCT staging_formula_id FROM _expand_uniq)
    AND btrim(COALESCE(si.id_corante, '')) <> ''
    AND COALESCE(si.qtd_ml > 0 AND si.qtd_ml < 'Infinity'::numeric, false)
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
  -- DEFESA EM PROFUNDIDADE (P1-1 corrida / P1-2 cleanup falho, Codex xhigh): 0 item VÁLIDO no staging
  -- NUNCA apaga uma receita oficial existente. O `EXISTS` faz o DELETE só rodar quando o staging traz ao
  -- menos uma dose válida para SUBSTITUIR a receita — "trocar" a receita exige receita nova.
  -- Cobre os dois furos que sobram fora desta RPC: (a) header cujo run fechou mas cujos itens se perderam
  -- (o edge apaga o header no cleanup e IGNORA o erro dessa deleção, depois promove com errors>0); e
  -- (b) qualquer outra via em que o header chegue sem itens. Sem isto, "sem itens" era lido como base pura
  -- e o DELETE ZERAVA a receita — exatamente o padrão que produziu as 28.609 fórmulas vazias de março.
  -- Fórmula NOVA sem receita anterior segue virando base pura legítima (nada a apagar, nada a preservar).
  DELETE FROM tint_formula_itens fi
  USING _promoted pr
  WHERE fi.formula_id = pr.formula_id
    AND EXISTS (
      SELECT 1 FROM tint_staging_formula_itens si
      WHERE si.staging_formula_id = pr.staging_formula_id
        AND btrim(COALESCE(si.id_corante, '')) <> ''
        AND COALESCE(si.qtd_ml > 0 AND si.qtd_ml < 'Infinity'::numeric, false)
    );

  INSERT INTO tint_formula_itens (formula_id, corante_id, ordem, qtd_ml)
  -- 20260622210000 (estanca RE-LOOP): DEDUP por (formula_id, corante_id). A FORMULA do SayerSystem
  -- pode trazer o MESMO corante em 2 slots/ordens (dosagem em 2 etapas; ex. 997M corante 3 = 0.385 +
  -- 14.09). aggregateFlatFormulaItems envia 2 itens; SEM dedup o INSERT viola o unique
  -- tint_formula_itens_formula_id_corante_id_key (23505) → ROLLBACK do batch → edge 500 → o conector
  -- não cacheia o lote → re-envia o batch CHEIO p/ sempre (re-loop). DISTINCT ON ... ORDER BY ordem DESC
  -- = MAIOR ORDEM VENCE: idêntico ao que o CSV-import já gravou no oficial (validado em prod: 344M
  -- c1=ordem3, 997M c3=ordem5, 638S) → IDEMPOTENTE, zero mudança de dosagem. NÃO somar (mudaria a
  -- dosagem/preço de cor ativa; somar dosagens distintas é decisão de domínio separada).
  SELECT DISTINCT ON (pr.formula_id, co.id)
         pr.formula_id, co.id, si.ordem, round((si.qtd_ml * pr.fator)::numeric, 6)
  FROM _promoted pr
  JOIN tint_staging_formula_itens si ON si.staging_formula_id = pr.staging_formula_id
  JOIN tint_corantes co ON co.account = v_account AND co.id_corante_sayersystem = si.id_corante
  -- P1-5: MESMO predicado de dose válida do guard/stub/itens_dedup (positiva E finita). O antigo
  -- `COALESCE(qtd_ml,0) > 0` deixava NaN entrar na receita (em numeric, NaN > 0 é VERDADEIRO).
  WHERE btrim(COALESCE(si.id_corante, '')) <> ''
    AND COALESCE(si.qtd_ml > 0 AND si.qtd_ml < 'Infinity'::numeric, false)
  -- tie-break determinístico (Codex P2): se 2 itens compartilham (formula,corante,ordem) — dado sujo —
  -- qtd_ml DESC, id DESC torna o pick estável em vez de não-determinístico num caminho money-path.
  ORDER BY pr.formula_id, co.id, si.ordem DESC, si.qtd_ml DESC, si.id DESC;

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

  -- Fórmulas que usam um corante cujo CUSTO mudou neste run (volume sem custo → preço NULL: inútil).
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
      -- 20260618 (fix CARGA E4): SÓ recalcula quando há CUSTO. O SayerSystem não manda custo (preço vem
      -- do Omie, §14) → sem isto o re-envio (volume_ml sempre presente) recalculava ~481k fórmulas por
      -- corante, uma a uma, num único run → gateway timeout → advisory lock preso → cascata (incidente
      -- 18/06). Sem custo o recálculo dá NULL e o COALESCE preserva o piso — ou seja, seria carga inútil.
      AND sc.custo IS NOT NULL
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
