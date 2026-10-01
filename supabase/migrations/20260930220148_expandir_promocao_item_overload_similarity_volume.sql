-- 20260930220148_expandir_promocao_item_overload_similarity_volume.sql
-- ============================================================
-- expandir_promocao_item: a expansão de SKU ao adicionar item de promoção (front:
-- AdminReposicaoPromocaoDetail.tsx, rpc com { p_item_id }) estava quebrada em prod por 2 defeitos
-- independentes, e o conserto dos 2 destravaria um 3º que eles escondiam. Issue #2665; diário
-- docs/historico/expandir-promocao-item-overload.md. Medido por psql-ro em 2026-09-30 (02:24 UTC).
-- ============================================================
-- 1. CHAMADA AMBÍGUA (42725). Coexistiam (p_item_id bigint) e (p_item_id bigint,
--    p_threshold_similaridade numeric DEFAULT 0.5); a chamada de 1 argumento casa os dois e dá
--    "is not unique", nomeada e posicional. As expansões automáticas param em 2026-05-13. Decisão do
--    founder: fica o de 2 argumentos (o corpo com o LIKE escapado da 20260929000234; a tela já exibe
--    os estados de similaridade dele) e o (bigint) sai. O front não muda: 1 argumento resolve no
--    default 0,5.
-- 2. similarity() FORA DO search_path (42883 no parse). O corpo roda com search_path = public,
--    pg_temp, e o pg_trgm mora em `extensions`. O parse resolve a chamada até no ramo não tomado de
--    um CASE, então quebravam o ramo de similaridade (0 variantes) e o laço de expansão (>=2
--    variantes): só o caminho "único" rodava. As 5 chamadas viram extensions.similarity(...), sem
--    abrir o search_path. Medido: authenticated, anon, service_role e postgres têm USAGE em
--    `extensions` e EXECUTE em extensions.similarity(text,text), que é o que a chamada qualificada
--    exige do chamador (a função é INVOKER).
-- 3. EXPANSÃO QUE APAGAVA O ITEM (provado em PG17). Cada variante sai com (campanha_id,
--    sku_codigo_fornecedor, volume_minimo) iguais aos do original, e o UNIQUE uq_item_na_campanha é
--    sobre essas 3 colunas. Com volume_minimo NULL não colide (NULL não colide com NULL); com volume
--    preenchido, as N colidem com o próprio original, o ON CONFLICT DO NOTHING as engole, e o
--    original era desativado assim mesmo, com as observações zeradas (texto || NULL) e a resposta
--    'expandido'. Consertar 1+2 sem isto trocaria um erro visível por perda silenciosa. Decisão do
--    founder: com volume preenchido não expande; o item fica ativo, 'ambiguo', com os candidatos (no
--    formato do resolver_sku_por_codigo_fornecedor), e a tela mostra "Pendente" (o mapeamento manual
--    contorna o UNIQUE com o sufixo #omie<id>). E laço sem nenhuma inserção aborta em vez de
--    desativar o original. Volume vazio (150 dos 151 itens de prod) segue igual.
--
-- O corpo é o de PROD (md5 do prosrc bc8f2c0e..., o da 20260929000234), gerado por script com contagem
-- exata por troca. O (bigint) sai com DROP sem CASCADE: db/preflight-dependencia-funcao.sql deu 0
-- linhas acionáveis (nenhuma rotina, trigger, policy, view, default, índice ou cron o chama); o COMMENT
-- dele vai junto. No mesmo PR sai a entrada OVERLOAD_FORA_DO_REPO dele em
-- db/deriva-corpo-baseline.json (#2667).
--
-- Prova: db/test-expandir-promocao-item.sh (PG17 sobre o schema-snapshot, predecessores = corpos de
-- prod por md5; os 3 defeitos reproduzidos antes do conserto; 0, 1 e >=2 variantes, com e sem volume,
-- com e sem similaridade, e a chamada do front como authenticated; PRE/POS exercitadas; --falsificar).
-- Aplicação: SQL Editor (DROP é DDL destrutivo, do founder), por isso o BEGIN/COMMIT. Re-colar é
-- seguro: a PRE aceita o corpo desta migration e o DROP é IF EXISTS.
-- Reverter = migration compensatória com os 2 corpos de prod de 2026-09-30, o que devolve o 42725.

BEGIN;

-- Pré-condição. Cada linha de pg_proc é TRAVADA antes da leitura (ALTER com o MESMO search_path,
-- padrão da 20260927195430), e a trava tem de ser no-op. Depois, o md5 EXATO do prosrc:
--   · (bigint,numeric), o que fica: o de prod (= 20260929000234) ou JÁ o desta migration. Ausente
--     aborta.
--   · (bigint), o que sai: se ainda existe, só o de prod medido; outro corpo é mudança que o DROP
--     apagaria às cegas. Ausente é o estado de quem já aplicou.
-- E as dependências late-bound do corpo novo (o CREATE não as valida; faltando uma, só o 1º uso
-- quebraria), vistas pelo papel que chama pelo front: authenticated.
DO $pre$
DECLARE
  v_oid oid;
  v_antes text[];
  v_depois text[];
  v_md5 text;
BEGIN
  v_oid := to_regprocedure('public.expandir_promocao_item(bigint,numeric)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: expandir_promocao_item(bigint,numeric) ausente. A migration parte do corpo de prod (20260929000234)';
  END IF;
  SELECT p.proconfig INTO v_antes FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  ALTER FUNCTION public.expandir_promocao_item(bigint, numeric) SET search_path = public, pg_temp;
  SELECT p.proconfig, md5(p.prosrc) INTO v_depois, v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  IF v_antes IS DISTINCT FROM v_depois OR v_depois IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'PRE FALHOU: a config de (bigint,numeric) era % e a trava a deixou em %. A trava tem de ser no-op', v_antes, v_depois;
  END IF;
  IF v_md5 IS NULL OR v_md5 NOT IN ('bc8f2c0e7a85ccdf89b5e5cd59b84e38', '566edd782fb00616c6d658b9562020d2') THEN
    RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de (bigint,numeric) (md5 %) não é o de prod nem o desta migration. Reconcilie antes', v_md5;
  END IF;
  -- Para a POS: o CREATE OR REPLACE preserva OID e ACL; um DROP+CREATE troca os dois.
  PERFORM set_config('expandir_promocao.oid_pre', v_oid::text, true);
  PERFORM set_config('expandir_promocao.acl_pre',
    (SELECT coalesce(p.proacl::text, '') FROM pg_catalog.pg_proc p WHERE p.oid = v_oid), true);

  v_oid := to_regprocedure('public.expandir_promocao_item(bigint)');
  IF v_oid IS NOT NULL THEN
    SELECT p.proconfig INTO v_antes FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
    ALTER FUNCTION public.expandir_promocao_item(bigint) SET search_path = public, pg_temp;
    SELECT p.proconfig, md5(p.prosrc) INTO v_depois, v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
    IF v_antes IS DISTINCT FROM v_depois OR v_depois IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
      RAISE EXCEPTION 'PRE FALHOU: a config de (bigint) era % e a trava a deixou em %. A trava tem de ser no-op', v_antes, v_depois;
    END IF;
    IF v_md5 IS DISTINCT FROM '6677fa80de976b37dd784544058ccf4b' THEN
      RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de (bigint) (md5 %) não é o de prod medido. Reconcilie antes de dropar', v_md5;
    END IF;
  END IF;

  IF to_regprocedure('extensions.similarity(text,text)') IS NULL
     OR NOT pg_catalog.has_schema_privilege('authenticated', 'extensions', 'USAGE')
     OR NOT pg_catalog.has_function_privilege('authenticated', to_regprocedure('extensions.similarity(text,text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'PRE FALHOU: extensions.similarity(text,text) ausente ou fora do alcance de authenticated (USAGE + EXECUTE)';
  END IF;
  IF to_regprocedure('private.padrao_like_contem(text)') IS NULL
     OR NOT pg_catalog.has_schema_privilege('authenticated', 'private', 'USAGE')
     OR NOT pg_catalog.has_function_privilege('authenticated', to_regprocedure('private.padrao_like_contem(text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'PRE FALHOU: private.padrao_like_contem(text) ausente ou fora do alcance de authenticated (USAGE + EXECUTE)';
  END IF;
END
$pre$;

-- O overload de 1 argumento sai. Sem CASCADE: dependente novo tem de dar ERRO, não demolição silenciosa.
DROP FUNCTION IF EXISTS public.expandir_promocao_item(bigint);

-- O que fica: o corpo de PROD com 3 mudanças (5x extensions.similarity; volume preenchido vira
-- 'ambiguo'; laço sem inserção aborta). CREATE OR REPLACE preserva OID, ACL e dono.
CREATE OR REPLACE FUNCTION public.expandir_promocao_item(p_item_id bigint, p_threshold_similaridade numeric DEFAULT 0.5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item record;
  v_variantes_count int;
  v_variante record;
  v_novos_ids bigint[] := ARRAY[]::bigint[];
  v_novo_id bigint;
  v_usou_similaridade boolean := false;
  v_similar_max numeric;
  v_candidatos jsonb := '[]'::jsonb;
BEGIN
  SELECT pi.*, pc.empresa INTO v_item
  FROM promocao_item pi JOIN promocao_campanha pc ON pc.id = pi.campanha_id
  WHERE pi.id = p_item_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('erro', 'item_nao_encontrado', 'item_id', p_item_id);
  END IF;
  IF v_item.mapeamento_qualidade = 'expandido_origem' THEN
    RETURN jsonb_build_object('erro', 'ja_expandido', 'item_id', p_item_id);
  END IF;
  IF v_item.confirmado = true AND v_item.sku_codigo_omie IS NOT NULL THEN
    RETURN jsonb_build_object('erro', 'ja_confirmado', 'item_id', p_item_id);
  END IF;

  SELECT COUNT(*) INTO v_variantes_count
  FROM listar_skus_por_codigo_fornecedor(v_item.empresa, v_item.sku_codigo_fornecedor);

  IF v_variantes_count = 0 THEN
    SELECT MAX(extensions.similarity(op.descricao, v_item.sku_codigo_fornecedor))
    INTO v_similar_max
    FROM omie_products op
    WHERE LOWER(op.account) = LOWER(v_item.empresa) AND COALESCE(op.ativo, true) = true;

    IF v_similar_max >= p_threshold_similaridade THEN
      v_usou_similaridade := true;
      SELECT COUNT(*) INTO v_variantes_count
      FROM omie_products op
      WHERE LOWER(op.account) = LOWER(v_item.empresa)
        AND COALESCE(op.ativo, true) = true
        AND extensions.similarity(op.descricao, v_item.sku_codigo_fornecedor) >= p_threshold_similaridade;
    END IF;
  END IF;

  IF v_variantes_count = 0 THEN
    UPDATE promocao_item 
    SET mapeamento_qualidade = 'nao_encontrado',
        sku_codigo_omie = NULL, mapeamento_candidatos = NULL
    WHERE id = p_item_id;
    RETURN jsonb_build_object(
      'status', 'nao_encontrado', 'item_id', p_item_id,
      'codigo_fornecedor', v_item.sku_codigo_fornecedor,
      'melhor_similaridade', v_similar_max
    );
  END IF;

  IF v_variantes_count = 1 THEN
    IF v_usou_similaridade THEN
      SELECT op.omie_codigo_produto, op.descricao, op.codigo INTO v_variante
      FROM omie_products op
      WHERE LOWER(op.account) = LOWER(v_item.empresa) AND COALESCE(op.ativo, true) = true
        AND extensions.similarity(op.descricao, v_item.sku_codigo_fornecedor) >= p_threshold_similaridade
      ORDER BY extensions.similarity(op.descricao, v_item.sku_codigo_fornecedor) DESC LIMIT 1;
    ELSE
      SELECT omie_codigo_produto, descricao, codigo_interno AS codigo INTO v_variante
      FROM listar_skus_por_codigo_fornecedor(v_item.empresa, v_item.sku_codigo_fornecedor) LIMIT 1;
    END IF;

    UPDATE promocao_item 
    SET mapeamento_qualidade = CASE WHEN v_usou_similaridade THEN 'unico_por_similaridade' ELSE 'unico' END,
        sku_codigo_omie = v_variante.omie_codigo_produto,
        descricao_produto_fornecedor = COALESCE(descricao_produto_fornecedor, v_variante.descricao),
        confirmado = NOT v_usou_similaridade,
        mapeamento_candidatos = NULL,
        observacoes = CASE WHEN v_usou_similaridade THEN 
          COALESCE(observacoes, '') || ' [Resolvido por similaridade — revisar]' ELSE observacoes END
    WHERE id = p_item_id;

    RETURN jsonb_build_object(
      'status', CASE WHEN v_usou_similaridade THEN 'resolvido_por_similaridade' ELSE 'resolvido_unico' END,
      'item_id', p_item_id,
      'sku_codigo_omie', v_variante.omie_codigo_produto,
      'descricao', v_variante.descricao
    );
  END IF;

  FOR v_variante IN 
    SELECT op.omie_codigo_produto, op.descricao, op.codigo AS codigo_interno
    FROM omie_products op
    WHERE LOWER(op.account) = LOWER(v_item.empresa) AND COALESCE(op.ativo, true) = true
      AND (CASE WHEN v_usou_similaridade 
                THEN extensions.similarity(op.descricao, v_item.sku_codigo_fornecedor) >= p_threshold_similaridade
                ELSE op.descricao ILIKE private.padrao_like_contem(v_item.sku_codigo_fornecedor) ESCAPE '\' END)
    ORDER BY op.descricao
  LOOP
    IF v_item.volume_minimo IS NOT NULL THEN
      v_candidatos := v_candidatos || jsonb_build_object(
        'omie_codigo_produto', v_variante.omie_codigo_produto,
        'descricao', v_variante.descricao,
        'codigo_interno', v_variante.codigo_interno);
      CONTINUE;
    END IF;
    INSERT INTO promocao_item (
      campanha_id, sku_codigo_fornecedor, descricao_produto_fornecedor,
      sku_codigo_omie, mapeamento_qualidade, mapeamento_candidatos,
      desconto_perc, volume_minimo, confirmado, ativo, observacoes
    ) VALUES (
      v_item.campanha_id, v_item.sku_codigo_fornecedor, v_variante.descricao,
      v_variante.omie_codigo_produto,
      CASE WHEN v_usou_similaridade THEN 'expandido_por_similaridade' ELSE 'expandido_automatico' END,
      NULL, v_item.desconto_perc, v_item.volume_minimo,
      NOT v_usou_similaridade, true,
      COALESCE(v_item.observacoes, '') || ' [Expandido' ||
        CASE WHEN v_usou_similaridade THEN ' por similaridade' ELSE ' automaticamente' END ||
        ' do código ' || v_item.sku_codigo_fornecedor || ' — variante: ' || v_variante.descricao || ']'
    )
    ON CONFLICT (campanha_id, sku_codigo_fornecedor, volume_minimo) DO NOTHING
    RETURNING id INTO v_novo_id;
    IF v_novo_id IS NOT NULL THEN
      v_novos_ids := array_append(v_novos_ids, v_novo_id);
    END IF;
  END LOOP;

  -- O UNIQUE (campanha_id, sku_codigo_fornecedor, volume_minimo) só admite N variantes com o código
  -- do original enquanto volume_minimo é NULL (NULL não colide com NULL). Com volume preenchido,
  -- cada variante colidiria com o próprio original e o ON CONFLICT engoliria as N. Não expande: o
  -- item fica ativo, 'ambiguo', com os candidatos, para o mapeamento manual (que contorna o UNIQUE
  -- com o sufixo #omie<id>).
  IF v_item.volume_minimo IS NOT NULL THEN
    UPDATE promocao_item
    SET mapeamento_qualidade = 'ambiguo',
        sku_codigo_omie = NULL,
        mapeamento_candidatos = v_candidatos
    WHERE id = p_item_id;
    RETURN jsonb_build_object(
      'status', 'ambiguo', 'item_id', p_item_id,
      'motivo', 'volume_minimo_impede_expansao',
      'total_matches', jsonb_array_length(v_candidatos),
      'candidatos', v_candidatos,
      'requer_revisao', true
    );
  END IF;

  -- Nenhuma variante inserida: desativar o original o tiraria da campanha sem substituto.
  IF cardinality(v_novos_ids) = 0 THEN
    RAISE EXCEPTION 'expandir_promocao_item: nenhuma das % variantes do item % foi inserida; o original não foi desativado',
      v_variantes_count, p_item_id;
  END IF;

  UPDATE promocao_item 
  SET ativo = false, mapeamento_qualidade = 'expandido_origem',
      observacoes = COALESCE(observacoes, '') || 
        ' [Item original — expandido em ' || array_length(v_novos_ids, 1) || ' variantes' ||
        CASE WHEN v_usou_similaridade THEN ' (similaridade)' ELSE '' END || ']'
  WHERE id = p_item_id;

  RETURN jsonb_build_object(
    'status', CASE WHEN v_usou_similaridade THEN 'expandido_por_similaridade' ELSE 'expandido' END,
    'item_id_original', p_item_id,
    'variantes_criadas', array_length(v_novos_ids, 1),
    'novos_ids', v_novos_ids,
    'requer_revisao', v_usou_similaridade
  );
END;
$function$;

COMMENT ON FUNCTION public.expandir_promocao_item(bigint, numeric) IS
  'Mapeia um item de promoção para os SKUs Omie cuja descrição contém o código do fornecedor (LIKE '
  'literal, via listar_skus_por_codigo_fornecedor). 0 variantes: tenta similaridade (pg_trgm, >= '
  'p_threshold_similaridade, default 0,5); sem nada, marca nao_encontrado. 1 variante: resolve in-place '
  '(unico; unico_por_similaridade sai sem confirmar). N variantes: cria N itens irmãos e desativa o '
  'original; com volume_minimo preenchido não expande (o UNIQUE colidiria com o original) e marca '
  'ambiguo com os candidatos. Laço sem nenhuma inserção aborta. Issue #2665.';

-- O PostgREST relê o schema para parar de ver o overload que saiu. Em prod os event triggers
-- pgrst_ddl_watch/pgrst_drop_watch já fazem isto; o NOTIFY não depende deles.
NOTIFY pgrst, 'reload schema';

-- Pós-condição. Os predicados semânticos vêm antes do md5: depois dele seriam inalcançáveis, e a
-- mensagem que diz O QUE está errado se perderia.
DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.expandir_promocao_item(bigint,numeric)');
  v_n int;
  v_src text;
  v_plano text;
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'expandir_promocao_item';
  IF v_oid IS NULL OR v_n <> 1 THEN
    RAISE EXCEPTION 'POS1 FALHOU: esperado só expandir_promocao_item(bigint,numeric) em public; há % overload(s)', v_n;
  END IF;
  -- A chamada do front (1 argumento, nomeada) tem de resolver. EXPLAIN analisa sem executar.
  BEGIN
    EXECUTE 'EXPLAIN SELECT public.expandir_promocao_item(p_item_id => 1::bigint)' INTO v_plano;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'POS2 FALHOU: a chamada do front não resolve: % %', SQLSTATE, left(SQLERRM, 120);
  END;
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  IF v_src ~ '(^|[^.[:alnum:]_])similarity[[:space:]]*\(' THEN
    RAISE EXCEPTION 'POS3 FALHOU: sobrou similarity() sem schema, que dá 42883 no parse com search_path = public, pg_temp';
  END IF;
  IF md5(v_src) IS DISTINCT FROM '566edd782fb00616c6d658b9562020d2' THEN
    RAISE EXCEPTION 'POS4 FALHOU: o corpo instalado (md5 %) não é o desta migration', md5(v_src);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = v_oid AND NOT p.prosecdef AND p.provolatile = 'v'
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']
                    AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres') THEN
    RAISE EXCEPTION 'POS5 FALHOU: mudou SECURITY, volatilidade, search_path ou dono';
  END IF;
  IF v_oid::text IS DISTINCT FROM current_setting('expandir_promocao.oid_pre', true)
     OR (SELECT coalesce(p.proacl::text, '') FROM pg_catalog.pg_proc p WHERE p.oid = v_oid)
        IS DISTINCT FROM current_setting('expandir_promocao.acl_pre', true) THEN
    RAISE EXCEPTION 'POS6 FALHOU: OID ou ACL mudou desde a PRE. CREATE OR REPLACE preserva os dois; DROP+CREATE não';
  END IF;
  RAISE NOTICE 'POS OK: 1 overload, a chamada de 1 argumento resolve, similarity qualificada, corpo/atributos/ACL conferidos';
END
$post$;

COMMIT;
