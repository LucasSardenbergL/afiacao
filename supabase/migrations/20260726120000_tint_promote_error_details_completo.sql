-- 20260726120000_tint_promote_error_details_completo.sql
-- DIAGNÓSTICO HONESTO do Guard 4 (money-path) — o log de "receita corrompida" para de ESCONDER e
-- de ACUSAR ERRADO. Corpo VERBATIM da v5 (20260722113000/Fase 1d) + 3 mudanças marcadas [DIAG-*].
-- ZERO mudança de comportamento de promoção: o conjunto de fórmulas barradas é idêntico ao da v5.
--
-- O BUG (observado em prod 2026-07-21, 1º ciclo do conector 0.2.0): o error_details.itens FILTRAVA
-- os itens sem corante (`AND si.id_corante IS NOT NULL AND btrim(si.id_corante) <> ''`) — justamente
-- a classe de linha que o ramo (b) do guard existe para pegar. A fórmula `303U - BS`/`NB.9142` foi
-- barrada e o log exibiu 3 itens TODOS com dose válida (12,71 / 3,93 / 32,35 ml): lido de fora, um
-- falso positivo do guard. A staging crua tinha um 4º item — id_corante VAZIO, qtd_ml 2,4645 — que
-- era o motivo real. Só a consulta crua à tint_staging_formula_itens revelava a causa.
--
-- AGRAVANTE (mesmo defeito, outra face): a error_message era FIXA e descrevia só o ramo (a)
-- ("corante presente sem dose válida (qtd_ml <= 0/nula)"). Na NB.9142 quem disparou foi o ramo (b)
-- (órfão) + o (c) [1d-E] — ou seja, a mensagem afirmava o ÚNICO ramo que NÃO disparou. O log não
-- só omitia o culpado: acusava o inocente. Money-path §2 (degradação honesta) aplicado ao
-- DIAGNÓSTICO — um log que afirma causa não-verificada é da mesma família do número fabricado.
--
-- As 3 mudanças:
--   [DIAG-A] a CULPA vira dado de 1ª classe: _fl_culpa guarda (staging_formula_id, motivo,
--            item_ids) com os 3 ramos de predicado VERBATIM — só a projeção cresce. A DECISÃO
--            (_fl_corrompida) segue sendo o DISTINCT das fórmulas que os ramos produzem, com a
--            MESMA cardinalidade de grupos da v5 → nenhuma fórmula muda de lado.
--            ⚠️ item_ids é PAYLOAD: a decisão NUNCA passa por unnest() — um array vazio/NULL faria
--            a fórmula ESCAPAR do guard (fail-OPEN, subfaturamento silencioso). O log depende da
--            decisão; a decisão jamais depende do log. Provado por Flog-4 (esvazia item_ids e
--            exige que a fórmula SIGA barrada).
--   [DIAG-B] error_details.itens passa a trazer TODOS os itens da fórmula (sem o filtro de corante),
--            cada um marcado com `viola` (bool) + `motivos` (array, NULL quando não viola). Os itens
--            válidos preservam id_corante/ordem/qtd_ml VERBATIM (compat: o único leitor é a UI de
--            TintSyncRuns, que faz JSON.stringify; ninguém acessa .itens[] estruturalmente).
--            Ordem determinística `ordem NULLS LAST, id` — `ordem` é NULLABLE e agora órfãos entram.
--   [DIAG-C] error_message derivada dos motivos que REALMENTE dispararam, preservando o prefixo
--            'receita corrompida: ' (todos os asserts e a UI casam por LIKE '%corrompida%').
--
-- Um item pode violar por >1 ramo (o órfão da NB.9142 dispara (b) e (c)) → `motivos` é array.
--
-- ⚠️ NaN/Infinity em qtd_ml NÃO quebram o jsonb: o PG17 serializa numeric não-finito como STRING
-- ("NaN"/"Infinity"), não levanta erro nem vira null (probe PG17 2026-07-21). O tipo do campo muda
-- (number→string) conforme o valor; inócuo aqui porque não há consumidor estrutural.
--
-- Sem mudança de schema, sem mudança de edge, sem ordem de deploy acoplada: é só CREATE OR REPLACE.
-- Provado: db/test-tint-promote.sh C38-C40 + falsificações Flog-1..4. SQL Editor (§deploy.md).

-- (0) pré-flight por HASH EXATO (mesmo padrão da v5; Codex P1 2026-07-20: marcador de substring
-- aceitava hotfix divergente que mantivesse o nome — o CREATE OR REPLACE sobrescreveria silencioso).
-- Caminho principal: md5(pg_get_functiondef) da v5/1d medido em PROD 2026-07-21 via psql-ro =
-- 4abf2ae2eb74d52b01fcb09d5190be42. Re-apply da própria v6: aceito pelo marcador ESTRUTURAL
-- exclusivo `CREATE TEMP TABLE _fl_culpa` — o md5 da v6 EM PROD só existe após o 1º apply;
-- capture-o na validação pós-apply (lovable-db-operator) e registre no PR.
-- ⚠️ O marcador é a LINHA DE CRIAÇÃO da temp table, não o nome solto: pg_get_functiondef devolve
-- o corpo COM os comentários, e os comentários [DIAG-A] abaixo citam "_fl_culpa" em prosa — um
-- LIKE '%_fl_culpa%' casaria pelo COMENTÁRIO mesmo com o código ausente (a armadilha #1472/#1488:
-- a própria migration escreve o texto que o fiscal lê de volta). 'CREATE TEMP TABLE _fl_culpa'
-- não aparece em nenhum comentário deste arquivo.
-- Qualquer outro estado → ABORTA com o md5 atual na mensagem (diagnóstico).
DO $pf$
DECLARE v_def text; v_md5 text;
BEGIN
  -- Harness PG17 local (db/test-tint-promote.sh): o md5 do functiondef varia entre versões
  -- maiores do PG (formatação do envelope) — o hash exato só vale contra PROD. O bypass é
  -- pelo NOME do banco de teste (prod Supabase é 'postgres'; superfície zero em prod).
  IF current_database() = 'tintpromote_verify' THEN
    RETURN;
  END IF;
  v_def := pg_get_functiondef('public.tint_promote_sync_run(uuid)'::regprocedure);
  v_md5 := md5(v_def);
  IF v_md5 = '4abf2ae2eb74d52b01fcb09d5190be42' THEN
    RETURN; -- v5/1d exata de prod: caminho esperado do 1º apply
  END IF;
  IF v_def LIKE '%CREATE TEMP TABLE _fl_culpa%' THEN
    RETURN; -- v6 já aplicada (re-apply idempotente)
  END IF;
  RAISE EXCEPTION 'pré-flight DIAG: tint_promote_sync_run em prod NÃO é a v5/1d esperada (md5=% ≠ 4abf2ae2eb74d52b01fcb09d5190be42) nem a v6 — a função divergiu da cadeia do repo (hotfix manual?). PARE, rode pg_get_functiondef, compare com o repo e reconcilie antes de aplicar.', v_md5;
END $pf$;

-- (1) coluna do sinal semântico
ALTER TABLE public.tint_staging_formulas ADD COLUMN IF NOT EXISTS is_base_pura boolean;
COMMENT ON COLUMN public.tint_staging_formulas.is_base_pura IS
  'Protocolo Fase 1d: sinal SEMÂNTICO da fonte — true = o conector CONFIRMOU fórmula sem corante (flat: 6 slots livres + flat cols completos; child: formula_pk resolvida + 0 linhas na filha). NULL/false = não-declarado (vazio ambíguo barra, comportamento v3/v4). A edge grava apenas literal true. Com a tríade (true + expected_item_count=0 + 0 itens ingeridos) a promoção aceita a fórmula vazia: transição legítima p/ base pura LIMPA a receita; sem a tríade, vazio barra SEMPRE (inclusive chave nova).';

-- (2) CREATE OR REPLACE tint_promote_sync_run — corpo VERBATIM da 20260718170000 com as mudanças
--     [1d-A] [1d-B] [1d-C] [1d-D] (geradas por transformação ancorada; ver PR).
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
  -- [1d] transições p/ base pura executadas neste run + cap anti-limpeza-em-massa.
  -- O cap é ACUMULADO em janela de 24h por (account,store) — Codex P0 2026-07-20: um cap
  -- por-promote era contornável em catraca (run A limpa 50, run B limpa as 2 restantes —
  -- as já-limpas deixavam de contar) e célula a célula. A soma durável vem do próprio
  -- rastro dos promotes (tint_sync_runs.metadata->>'receitas_limpas').
  v_limpezas       int := 0;
  v_limpezas_24h   int := 0;
  v_cap_limpezas   constant int := 50;
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
         id AS staging_formula_id, cor_id,
         -- 20260622 (fix nome_cor NULL): nome de cor PERSONALIZADA pode vir VAZIO do conector (lookup
         -- CorPerson não resolveu) → a constraint NOT NULL de tint_formulas.nome_cor derrubava o RUN
         -- INTEIRO (23502). Fallback p/ cor_id (stub, espelha o corante stub). Nunca abortar a promoção
         -- por um campo de DISPLAY ausente; o nome real entra no próximo upsert quando o conector resolver.
         -- Codex 22/06: CASE (não COALESCE+btrim) p/ NÃO trimar nome legítimo com espaço — só
         -- substitui quando NULL/vazio, preservando o nome_cor original VERBATIM.
         CASE WHEN nome_cor IS NULL OR btrim(nome_cor) = '' THEN cor_id ELSE nome_cor END AS nome_cor,
         cod_produto, id_base, id_embalagem,
         subcolecao, volume_final_ml, personalizada,
         -- [1c-A] protocolo Fase 1c: o nº de itens DECLARADO acompanha o header latest; o run DONO
         -- do header viaja junto p/ o log do gate (a promoção pode estar rodando por OUTRO run).
         expected_item_count,
         -- [1d-A] sinal semântico da FONTE acompanha o header latest (NULL = não-declarado).
         is_base_pura,
         sync_run_id AS header_sync_run_id
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
  -- PREDICADO ÚNICO de DOSE VÁLIDA (positiva E FINITA), reusado no guard, no itens_dedup do preço, no
  -- stub de corante e no INSERT de itens:  COALESCE(qtd_ml > 0 AND qtd_ml < 'Infinity'::numeric, false)
  -- Em `numeric` o NaN ordena ACIMA de tudo: `NaN <= 0` é FALSO e `NaN > 0` é VERDADEIRO — o critério
  -- ingênuo dava NaN como dose VÁLIDA no guard E no INSERT, e NaN entrava na receita contaminando preço.
  -- `< 'Infinity'` derruba NaN e +Inf; `> 0` derruba -Inf/zero/negativo; o COALESCE derruba NULL.
  -- [DIAG-A] A CULPA vira dado de PRIMEIRA CLASSE. Os 3 ramos abaixo têm predicado VERBATIM da v5 —
  -- só a PROJEÇÃO cresceu (motivo + ids das linhas culpadas), então o conjunto de staging_formula_id
  -- que eles produzem é idêntico e NENHUMA fórmula muda de lado. O log passa a ser SUBPRODUTO da
  -- decisão em vez de uma reconstrução dela (que seria um espelho livre para divergir em silêncio).
  -- ⚠️ item_ids é PAYLOAD PURO: a decisão (_fl_corrompida, logo abaixo) é o DISTINCT das LINHAS de
  -- _fl_culpa e NUNCA passa por unnest(item_ids) — se passasse, um array vazio/NULL faria a fórmula
  -- sumir do guard e PROMOVER corrompida (fail-OPEN, subfaturamento silencioso). Direção de falha:
  -- bug no payload degrada o LOG; jamais solta a promoção. Provado por Flog-4.
  CREATE TEMP TABLE _fl_culpa ON COMMIT DROP AS
  SELECT * FROM (
    -- (a) corante PRESENTE cujo conjunto de linhas não tem NENHUMA dose válida → o INSERT filtraria esse
    --     corante → receita PARCIAL (subfaturamento silencioso) ou ZERO. bool_and POR (formula,corante)
    --     preserva a dosagem em 2 etapas legítima (mesmo corante em 2 ordens, ambas válidas).
    --     Culpadas são TODAS as linhas daquele corante (nenhuma tem dose válida — a violação é do
    --     CONJUNTO, não de uma linha): array_agg dentro do próprio grupo.
    SELECT si.staging_formula_id,
           'corante_sem_dose_valida'::text AS motivo,
           array_agg(si.id) AS item_ids
    FROM tint_staging_formula_itens si
    JOIN _fl_resolved fl ON fl.staging_formula_id = si.staging_formula_id
    WHERE fl.produto_id IS NOT NULL AND fl.base_id IS NOT NULL
      AND fl.volume_final_ml IS NOT NULL AND fl.volume_final_ml > 0
      AND btrim(COALESCE(si.id_corante, '')) <> ''
    GROUP BY si.staging_formula_id, si.id_corante
    HAVING bool_and(NOT COALESCE(si.qtd_ml > 0 AND si.qtd_ml < 'Infinity'::numeric, false))
    UNION ALL
    -- (b) ITEM ÓRFÃO: dose sem corante identificado. O edge converte ID ausente em '' PRESERVANDO a dose
    --     (tint-sync-agent :506) — ignorar a linha perdia um componente da receita. ⚠️ O critério é
    --     `qtd_ml IS NOT NULL AND qtd_ml <> 0` — NÃO "dose válida": um órfão com dose NaN/Infinity/negativa
    --     cairia FORA dos dois ramos (o ramo (a) exige corante presente; um ramo (b) que exigisse dose
    --     positiva-finita não pegaria o não-finito) e a fórmula promoveria PARCIAL. Só NULL/0 é placeholder
    --     legítimo de slot vazio; qualquer outra quantidade sem corante é corrupção. (`NaN <> 0` é TRUE.)
    --     ⚠️ É EXATAMENTE esta classe de linha que o error_details da v5 escondia (o filtro de
    --     id_corante no subselect de itens): o ramo que pega o órfão era o único cujo culpado
    --     jamais aparecia no log. NB.9142, 2026-07-21.
    SELECT si.staging_formula_id,
           'dose_sem_corante'::text,
           ARRAY[si.id]
    FROM tint_staging_formula_itens si
    JOIN _fl_resolved fl ON fl.staging_formula_id = si.staging_formula_id
    WHERE fl.produto_id IS NOT NULL AND fl.base_id IS NOT NULL
      AND fl.volume_final_ml IS NOT NULL AND fl.volume_final_ml > 0
      AND btrim(COALESCE(si.id_corante, '')) = ''
      AND si.qtd_ml IS NOT NULL AND si.qtd_ml <> 0
    UNION ALL
    -- (c) [1d-E] PROTOCOLO 1d (expected declarado): o conector novo emite TODAS as linhas da
    --     fonte, inclusive as inválidas — logo QUALQUER linha que não seja {corante presente +
    --     dose válida} é corrupção transportada e barra a fórmula INTEIRA (all-or-nothing
    --     estrito por linha). Sem isto, 3 parciais mascaradas passavam (Codex P0/P1 2026-07-20):
    --     mesmo corante com dose válida + linha inválida (o bool_and POR corante do ramo (a)
    --     mascara e o INSERT faz fallback silencioso p/ outra ordem); placeholder real com irmão
    --     válido; slot flat ilegível emitido. Headers LEGADOS (expected NULL) mantêm o ramo (a)
    --     (dosagem em 2 etapas com linha zerada segue promovendo pela dose válida — C16).
    SELECT si.staging_formula_id,
           'linha_invalida_protocolo_1d'::text,
           ARRAY[si.id]
    FROM tint_staging_formula_itens si
    JOIN _fl_resolved fl ON fl.staging_formula_id = si.staging_formula_id
    WHERE fl.produto_id IS NOT NULL AND fl.base_id IS NOT NULL
      AND fl.volume_final_ml IS NOT NULL AND fl.volume_final_ml > 0
      AND fl.expected_item_count IS NOT NULL
      AND NOT (
        btrim(COALESCE(si.id_corante, '')) <> ''
        AND COALESCE(si.qtd_ml > 0 AND si.qtd_ml < 'Infinity'::numeric, false)
      )
  ) q;

  -- DECISÃO: o DISTINCT das LINHAS de _fl_culpa — NUNCA do unnest(item_ids) (ver [DIAG-A]).
  -- Conjunto idêntico ao da v5: mesmos 3 ramos, mesmos predicados, mesma cardinalidade de grupos.
  CREATE TEMP TABLE _fl_corrompida ON COMMIT DROP AS
  SELECT DISTINCT staging_formula_id FROM _fl_culpa;

  -- Loga UMA linha de erro por fórmula corrompida (espelha os guards 1-3; entity_id = cor_id).
  -- [DIAG-C] mensagem derivada dos motivos que REALMENTE dispararam. A v5 afirmava sempre o ramo (a);
  --   na NB.9142 dispararam (b)+(c) e a mensagem acusava o único ramo que NÃO disparou. O prefixo
  --   'receita corrompida: ' é preservado — asserts do harness e a UI casam por LIKE '%corrompida%'.
  --   ⚠️ O COALESCE não é decorativo: em SQL `'texto' || NULL` é NULL, então uma fórmula sem linha
  --   em _fl_culpa (impossível hoje — _fl_corrompida deriva dela) zeraria a mensagem INTEIRA e o
  --   LIKE '%corrompida%' deixaria de casar. Fail-closed do diagnóstico.
  -- [DIAG-B] itens: TODOS (sem o filtro de id_corante que escondia o órfão), cada um marcado com
  --   `viola` + `motivos`. Os itens VÁLIDOS preservam id_corante/ordem/qtd_ml verbatim (compat).
  --   `ordem` é NULLABLE e agora órfãos entram → ORDER BY ... NULLS LAST, si.id (determinístico).
  INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
  SELECT p_sync_run_id, 'formula_promote', fl.cor_id,
         'receita corrompida: ' || COALESCE((
           SELECT string_agg(m.txt, ' + ' ORDER BY m.txt)
           FROM (
             SELECT DISTINCT CASE c2.motivo
                      WHEN 'corante_sem_dose_valida'     THEN 'corante presente sem dose válida (qtd_ml <= 0/nula/não-finita)'
                      WHEN 'dose_sem_corante'            THEN 'dose sem corante identificado (item órfão)'
                      WHEN 'linha_invalida_protocolo_1d' THEN 'linha inválida sob protocolo declarado (1d-E)'
                      ELSE c2.motivo
                    END AS txt
             FROM _fl_culpa c2
             WHERE c2.staging_formula_id = fl.staging_formula_id
           ) m
         ), 'motivo não determinado') || ' — fórmula NÃO promovida, receita anterior preservada',
         jsonb_build_object(
           'cod_produto', fl.cod_produto, 'id_base', fl.id_base,
           'motivos', (
             SELECT to_jsonb(array_agg(DISTINCT c2.motivo ORDER BY c2.motivo))
             FROM _fl_culpa c2
             WHERE c2.staging_formula_id = fl.staging_formula_id
           ),
           'itens', (
             SELECT jsonb_agg(jsonb_build_object(
                      'id_corante', si.id_corante,
                      'ordem',      si.ordem,
                      'qtd_ml',     si.qtd_ml,
                      'viola',      (cul.motivos IS NOT NULL),
                      'motivos',    to_jsonb(cul.motivos)
                    ) ORDER BY si.ordem NULLS LAST, si.id)
             FROM tint_staging_formula_itens si
             LEFT JOIN LATERAL (
               SELECT array_agg(DISTINCT c2.motivo ORDER BY c2.motivo) AS motivos
               FROM _fl_culpa c2
               WHERE c2.staging_formula_id = si.staging_formula_id
                 AND si.id = ANY(c2.item_ids)
             ) cul ON true
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
    AND e.volume_ml IS NOT NULL AND e.volume_ml > 0
    -- fator não-finito (P1-7): volume 'Infinity'/'NaN' geraria fator 0/NaN e dose expandida corrompida
    -- mesmo com a dose bruta finita. A finitude tem de valer para TODOS os operandos, não só qtd_ml.
    AND fl.volume_final_ml < 'Infinity'::numeric
    AND e.volume_ml < 'Infinity'::numeric;
  -- ⚠️ O Guard 4 deliberadamente NÃO filtra AQUI. Vários candidatos de _formulas_latest (separados por
  -- subcoleção crua/personalizada) podem COLAPSAR na mesma chave oficial; remover o candidato corrompido
  -- ANTES do _expand_uniq fazia o PERDEDOR da colisão virar vencedor e substituir header/preço/receita da
  -- chave oficial em vez de PRESERVAR o oficial. O guard é aplicado DEPOIS da escolha do vencedor.

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
    -- MESMO predicado de dose válida do guard/stub/INSERT (positiva E finita): sem isto o preço somaria
    -- um item NaN/Infinity que o guard já considera inválido — duas definições da mesma fórmula.
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
  -- GUARD 4 APLICADO AQUI — DEPOIS de o vencedor da chave oficial estar escolhido. Se o VENCEDOR está
  -- corrompido, a chave oficial INTEIRA sai: sem fallback pro perdedor da colisão. Consequência (a
  -- desejada): aquela tint_formulas não entra em _promoted → não sofre o upsert de header NEM o DELETE
  -- de itens → header (preço, importacao_id, desativada_em) E receita ficam INTACTOS e COERENTES.
  DELETE FROM _expand_uniq eu
  USING _fl_corrompida c
  WHERE c.staging_formula_id = eu.staging_formula_id;

  -- ══════════════════════════════════════════════════════════════════════════
  -- [1c-B] GATE 1c (_eu_incompleta) — INTEGRIDADE DE TRANSPORTE do conjunto de itens. O header
  -- declara quantas linhas de item a fonte enviou (expected_item_count, edge handleFormulas); se o
  -- COUNT(*) BRUTO ingerido difere, o conjunto NÃO chegou inteiro (itens atravessam a fronteira de
  -- chunk de 1000 e o cleanup do edge pode falhar silencioso — tint-sync-agent :523) OU a promoção
  -- concorrente leu a ingestão a meio caminho. A fórmula INTEIRA sai (todas as embalagens), receita
  -- anterior preservada; em chave NOVA, nem header nasce (fecha o "fórmula vazia/parcial ativa" que
  -- o guard (c) não cobre — ele exige oficial COM receita). COUNT BRUTO de propósito (transporte ≠
  -- validade): dose inválida é papel dos guards 4a/4b, camadas independentes. NULL = protocolo
  -- legado/simulação → não entra aqui (caminho v3 intacto; 59% dos headers legítimos vivem em runs
  -- 'error' — gatear por status de run segue PROIBIDO). Posição: DEPOIS do vencedor da colisão
  -- (mesma lição do Guard 4 — sem fallback ao perdedor) e SEM fallback ao header completo mais
  -- antigo (promoveria estado velho como se fosse novo). Fail-closed transitório numa corrida com
  -- ingestão em curso se auto-resolve no promote seguinte (o latest fica íntegro).
  CREATE TEMP TABLE _eu_incompleta ON COMMIT DROP AS
  SELECT DISTINCT eu.staging_formula_id, fl.cor_id, fl.cod_produto, fl.id_base,
         fl.header_sync_run_id,
         fl.expected_item_count AS declarados,
         COALESCE(si.n, 0)      AS ingeridos
  FROM _expand_uniq eu
  JOIN _fl_resolved fl ON fl.staging_formula_id = eu.staging_formula_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS n FROM tint_staging_formula_itens si
    WHERE si.staging_formula_id = eu.staging_formula_id
  ) si ON true
  WHERE fl.expected_item_count IS NOT NULL
    AND fl.expected_item_count <> COALESCE(si.n, 0);

  -- header_sync_run_id (Codex P2): a promoção pode rodar por OUTRO run (B) e esbarrar no header
  -- incompleto do run A — o erro é atribuído ao promotor (sync_run_id) mas carrega o run DONO do
  -- header, senão métricas/investigação acusam o run errado. O re-log a cada promote enquanto o
  -- latest seguir incompleto é sinal HONESTO (padrão do Guard 4), não ruído a deduplicar.
  INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
  SELECT DISTINCT p_sync_run_id, 'formula_promote', inc.cor_id,
         'staging incompleto: itens ingeridos ≠ declarados (expected_item_count) — fórmula NÃO promovida, receita anterior preservada',
         jsonb_build_object('staging_formula_id', inc.staging_formula_id,
                            'cod_produto', inc.cod_produto, 'id_base', inc.id_base,
                            'header_sync_run_id', inc.header_sync_run_id,
                            'declarados', inc.declarados, 'ingeridos', inc.ingeridos)
  FROM _eu_incompleta inc;
  GET DIAGNOSTICS v_tmp = ROW_COUNT; v_erros := v_erros + v_tmp;

  DELETE FROM _expand_uniq eu
  USING _eu_incompleta inc
  WHERE inc.staging_formula_id = eu.staging_formula_id;

  -- ══════════════════════════════════════════════════════════════════════════
  -- [1d-B] SINAL DE BASE PURA CONTRADITÓRIO — fail-closed. is_base_pura=true só é
  -- coerente com a tríade (expected=0 E COUNT bruto=0). O gate 1c já barrou
  -- expected<>COUNT; aqui caem os residuais: declarada-pura COM itens presentes
  -- (expected=COUNT=N>0) e declarada-pura com expected NULL (edge novo sempre
  -- grava expected junto — NULL+true é artefato/protocolo misto). Promover como
  -- pigmentada ignoraria a declaração; limpar ignoraria os itens → barra + loga.
  CREATE TEMP TABLE _eu_pura_contraditoria ON COMMIT DROP AS
  SELECT DISTINCT eu.staging_formula_id, fl.cor_id, fl.cod_produto, fl.id_base,
         fl.header_sync_run_id, fl.expected_item_count AS declarados,
         COALESCE(si.n, 0) AS ingeridos
  FROM _expand_uniq eu
  JOIN _fl_resolved fl ON fl.staging_formula_id = eu.staging_formula_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS n FROM tint_staging_formula_itens si
    WHERE si.staging_formula_id = eu.staging_formula_id
  ) si ON true
  WHERE fl.is_base_pura IS TRUE
    AND (fl.expected_item_count IS NULL
         OR fl.expected_item_count <> 0
         OR COALESCE(si.n, 0) <> 0);

  INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
  SELECT DISTINCT p_sync_run_id, 'formula_promote', c.cor_id,
         'sinal de base pura contraditório: is_base_pura=true exige expected_item_count=0 e 0 itens ingeridos — fórmula NÃO promovida, receita anterior preservada',
         jsonb_build_object('staging_formula_id', c.staging_formula_id,
                            'cod_produto', c.cod_produto, 'id_base', c.id_base,
                            'header_sync_run_id', c.header_sync_run_id,
                            'declarados', c.declarados, 'ingeridos', c.ingeridos)
  FROM _eu_pura_contraditoria c;
  GET DIAGNOSTICS v_tmp = ROW_COUNT; v_erros := v_erros + v_tmp;

  DELETE FROM _expand_uniq eu
  USING _eu_pura_contraditoria c
  WHERE c.staging_formula_id = eu.staging_formula_id;

  -- (c') STAGING SEM RECEITA VÁLIDA → all-or-nothing, com UMA exceção DECLARADA [1d-C].
  --   v3/v4: barrava vazio APENAS sobre oficial COM receita; chave nova vazia PROMOVIA header
  --   vazio ativo (C15a) — com o conector velho filtrando inválidos antes do POST, uma fórmula
  --   nova toda-quebrada chegava como vazio "íntegro" e virava fórmula vazia ativa (o mal das
  --   28.609). v5 ENDURECE: vazio sem declaração barra SEMPRE (oficial com receita OU chave
  --   nova/sem receita — mensagens distintas p/ diagnóstico), e a TRÍADE DECLARADA
  --   (is_base_pura=true AND expected_item_count=0 AND 0 linhas brutas de item) libera:
  --   transição legítima pigmentada→pura LIMPA a receita (DELETE sem re-INSERT) e base pura
  --   NOVA cria header vazio legítimo. Fatos de prod que autorizam o endurecimento
  --   (psql-ro 2026-07-20): 0 fórmulas vazias na geração SL viva em 1 mês de sync;
  --   0 headers com expected=0 na história do staging.
  --   A tríade é re-checada INTEIRA aqui (não só is_base_pura): defesa em profundidade — o
  --   predicado não pode depender da ordem dos gates anteriores ([1d-B] já removeu as
  --   contraditórias, mas este WHERE tem de ser correto sozinho).
  CREATE TEMP TABLE _eu_sem_receita ON COMMIT DROP AS
  SELECT eu.staging_formula_id, eu.cor_id, eu.emb_id,
         EXISTS (
           SELECT 1 FROM tint_formulas f
           JOIN tint_formula_itens fi ON fi.formula_id = f.id
           WHERE f.account = v_account
             AND f.cor_id = eu.cor_id AND f.produto_id = eu.produto_id AND f.base_id = eu.base_id
             AND COALESCE(f.subcolecao_id, v_zero_uuid) = COALESCE(eu.subcolecao_id, v_zero_uuid)
             AND f.embalagem_id = eu.emb_id
         ) AS oficial_tem_receita
  FROM _expand_uniq eu
  JOIN _fl_resolved fl ON fl.staging_formula_id = eu.staging_formula_id
  WHERE NOT EXISTS (
      SELECT 1 FROM tint_staging_formula_itens si
      WHERE si.staging_formula_id = eu.staging_formula_id
        AND btrim(COALESCE(si.id_corante, '')) <> ''
        AND COALESCE(si.qtd_ml > 0 AND si.qtd_ml < 'Infinity'::numeric, false)
    )
    AND NOT (
      fl.is_base_pura IS TRUE
      AND fl.expected_item_count = 0
      AND NOT EXISTS (
        SELECT 1 FROM tint_staging_formula_itens si2
        WHERE si2.staging_formula_id = eu.staging_formula_id
      )
    );

  -- Mensagem VERBATIM da v3/v4 p/ o caso "oficial tem receita" (asserts e dashboards
  -- que casam '%sem receita%' seguem válidos); mensagem NOVA p/ o vazio em chave nova.
  INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
  SELECT DISTINCT p_sync_run_id, 'formula_promote', s.cor_id,
         'staging sem receita sobre fórmula que TEM receita — fórmula NÃO promovida (receita anterior preservada; transição p/ base pura exige sinal explícito da fonte)',
         jsonb_build_object('staging_formula_id', s.staging_formula_id)
  FROM _eu_sem_receita s
  WHERE s.oficial_tem_receita;
  GET DIAGNOSTICS v_tmp = ROW_COUNT; v_erros := v_erros + v_tmp;

  INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
  SELECT DISTINCT p_sync_run_id, 'formula_promote', s.cor_id,
         'staging vazio sem declaração de base pura — header NÃO criado (fórmula vazia ativa é o mal das 28.609; a fonte declara is_base_pura ou corrige a receita)',
         jsonb_build_object('staging_formula_id', s.staging_formula_id)
  FROM _eu_sem_receita s
  WHERE NOT s.oficial_tem_receita;
  GET DIAGNOSTICS v_tmp = ROW_COUNT; v_erros := v_erros + v_tmp;

  DELETE FROM _expand_uniq eu
  USING _eu_sem_receita s
  WHERE s.staging_formula_id = eu.staging_formula_id AND s.emb_id = eu.emb_id;

  -- ══════════════════════════════════════════════════════════════════════════
  -- [1d-D] CAP ANTI-LIMPEZA-EM-MASSA, ACUMULADO EM JANELA (defesa em profundidade).
  -- O apocalipse: no shape child, a tabela filha da ORIGEM esvaziada por glitch/wipe faria
  -- o conector declarar is_base_pura em TODAS as fórmulas → limparia a receita do catálogo,
  -- batch a batch. Transição p/ base pura é evento RARO (medido: 0 em 1 mês de fluxo vivo).
  -- ⚠️ Codex P0 (2026-07-20): cap POR PROMOTE era contornável em "catraca" — run A limpa 50,
  -- run B limpa as 2 restantes (as já-limpas deixam de satisfazer EXISTS e saem da conta), e
  -- células <51 destravavam uma a uma. O cap agora é ACUMULADO: candidatas deste promote +
  -- receitas JÁ LIMPAS nas últimas 24h no mesmo (account,store), lidas do rastro durável que
  -- o próprio promote grava (tint_sync_runs.metadata->>'receitas_limpas'). Estourou → NENHUMA
  -- limpeza executa (nem as 50 "de dentro do teto": fonte doente não ganha fatia), tudo barra
  -- + loga. A conta é por RECEITA OFICIAL (chave com embalagem) — 1 fórmula-fonte pode limpar
  -- N embalagens e o dano se mede em receitas. Base pura NOVA (sem receita oficial) não conta
  -- nem é barrada — criar N bases puras novas não destrói nada. Precisar limpar >50/24h
  -- legitimamente (reforma de catálogo) é decisão humana: migration pontual, não sync.
  CREATE TEMP TABLE _eu_limpezas ON COMMIT DROP AS
  SELECT DISTINCT eu.staging_formula_id, eu.cor_id, eu.emb_id
  FROM _expand_uniq eu
  JOIN _fl_resolved fl ON fl.staging_formula_id = eu.staging_formula_id
  WHERE fl.is_base_pura IS TRUE
    AND NOT EXISTS (
      SELECT 1 FROM tint_staging_formula_itens si
      WHERE si.staging_formula_id = eu.staging_formula_id
    )
    AND EXISTS (
      SELECT 1 FROM tint_formulas f
      JOIN tint_formula_itens fi ON fi.formula_id = f.id
      WHERE f.account = v_account
        AND f.cor_id = eu.cor_id AND f.produto_id = eu.produto_id AND f.base_id = eu.base_id
        AND COALESCE(f.subcolecao_id, v_zero_uuid) = COALESCE(eu.subcolecao_id, v_zero_uuid)
        AND f.embalagem_id = eu.emb_id
    );

  SELECT count(*) INTO v_limpezas FROM _eu_limpezas;

  -- Receitas já limpas na janela por promotes anteriores DESTE (account,store). O run atual
  -- ainda não gravou metadata (grava no E5) → não se conta em dobro.
  -- Alias 'tr' de propósito: 'r' é variável record da função e VENCERIA o alias
  -- (compila, explode em runtime — armadilha plpgsql documentada em tintometrico.md).
  SELECT COALESCE(sum((tr.metadata->>'receitas_limpas')::int), 0) INTO v_limpezas_24h
  FROM tint_sync_runs tr
  WHERE tr.account = v_account AND tr.store_code = v_store
    AND tr.started_at > now() - interval '24 hours'
    AND tr.metadata ? 'receitas_limpas';

  IF v_limpezas > 0 AND (v_limpezas + v_limpezas_24h) > v_cap_limpezas THEN
    INSERT INTO tint_sync_errors (sync_run_id, entity_type, entity_id, error_message, error_details)
    SELECT p_sync_run_id, 'formula_promote', l.cor_id,
           'limpeza em massa suspeita: ' || v_limpezas || ' receita(s) limpariam agora + ' || v_limpezas_24h || ' já limpas em 24h > cap ' || v_cap_limpezas || ' — NENHUMA limpeza executada, receitas preservadas; confira a tabela filha da ORIGEM',
           jsonb_build_object('staging_formula_id', l.staging_formula_id,
                              'limpezas_no_run', v_limpezas, 'limpezas_24h', v_limpezas_24h,
                              'cap', v_cap_limpezas)
    FROM _eu_limpezas l;
    GET DIAGNOSTICS v_tmp = ROW_COUNT; v_erros := v_erros + v_tmp;

    DELETE FROM _expand_uniq eu
    USING _eu_limpezas l
    WHERE l.staging_formula_id = eu.staging_formula_id;

    v_limpezas := 0;
  END IF;

  -- v_promovidas conta o que REALMENTE será gravado (linhas oficiais upsertadas), não as expansões
  -- pré-dedup: com o guard aqui, contar _expand reportaria como "promovida" uma fórmula barrada —
  -- número fabricado num contador money-path (registros_importados / tint_sync_runs.inserts).
  SELECT count(*) INTO v_promovidas FROM _expand_uniq;

  -- Corante stubs em massa ANTES dos itens (espelha tint_ensure_corante_stub: volume 1000).
  -- A partir de _expand_uniq (PÓS-guard) — não materializa corante de fórmula barrada. Mesmo predicado
  -- de dose válida do guard/INSERT (NaN/Infinity fora).
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
  DELETE FROM tint_formula_itens fi USING _promoted pr WHERE fi.formula_id = pr.formula_id;

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
  -- MESMO predicado de dose válida (positiva E finita). O antigo `COALESCE(qtd_ml,0) > 0` deixava NaN
  -- entrar na receita: em numeric, `NaN > 0` é VERDADEIRO.
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
    SET inserts = v_promovidas, errors = v_erros, metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('recalculadas', v_recalc, 'receitas_limpas', v_limpezas)
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
    'receitas_limpas', v_limpezas,
    'erros', v_erros, 'importacao_id', v_importacao_id);
END $$;
REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM anon, authenticated, PUBLIC;


SELECT 'tint_promote_sync_run FASE 1d (is_base_pura) OK' AS status;
