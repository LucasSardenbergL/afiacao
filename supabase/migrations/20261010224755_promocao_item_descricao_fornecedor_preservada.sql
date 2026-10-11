-- 20261010224755_promocao_item_descricao_fornecedor_preservada.sql
-- ============================================================
-- promocao_item.descricao_produto_fornecedor guarda o que o FORNECEDOR ofertou: o texto que a
-- extração por visão leu da campanha (promocao-extrair-via-vision, o único escritor que ORIGINA o
-- texto). Promoção alimenta o forward buying (aplicar_promocoes_no_ciclo), então o par "o que o
-- fornecedor ofertou × qual SKU recebeu o desconto" é a auditoria de um fluxo de dinheiro — e o
-- gabarito para um dia automatizar promoção→SKU. Dois escritores SQL trocavam esse texto pela
-- descrição do SKU Omie (o 3º era a tela de vínculo manual, consertada no mesmo PR):
--   · expandir_promocao_item: o ramo de 1 variante PREENCHIA o NULL com a descrição do SKU
--     (COALESCE), e o laço de >=2 variantes criava cada filha com a descrição do SKU dela;
--   · converter_sugestao_em_campanha_flat: o item nascia com a descrição do SKU da sugestão — a
--     negociação é interna (telefone/canal), não há texto do fornecedor.
-- Medido por psql-ro em 2026-10-10: 25 de 25 filhas 'expandido_automatico' nasceram com a
-- descrição do SKU (as 11 "diferentes" do catálogo atual são renomeação posterior no Omie — a
-- observação de cada filha grava a variante da época); 13 de 13 'manual_confirmado' iguais ao SKU
-- (a tela); 3 'unico' iguais ao SKU; 0 campanhas do converter. Contexto: docs/historico/
-- jev-backtest-ptbr.md §3 (PR #2719); diário docs/historico/promocao-descricao-fornecedor.md.
--
-- O conserto (corpos de PROD, md5 566edd782fb00616c6d658b9562020d2 e 557f962e0355b034097be8cf88c27a1a, gerados por troca exata):
--   1. expandir_promocao_item não atribui mais a descrição no ramo único, e a filha leva a da
--      ORIGEM (v_item.descricao_produto_fornecedor). O resto do corpo é o de prod, byte a byte.
--   2. converter_sugestao_em_campanha_flat não grava a descrição (fica NULL). Gate de staff,
--      SECURITY DEFINER, search_path e ACL intactos (CREATE OR REPLACE preserva OID e ACL).
--   A descrição do SKU passa a ser LIDA do catálogo pelo sku_codigo_omie (useDescricoesSkuOmie).
--   3. Backfill por MANIFESTO FECHADO (Codex P1: casar filha↔origem por regra não prova filiação):
--      as 12 filhas 'expandido_automatico' da campanha 1, criadas por esta função em 2026-04-21.
--      O original de cada uma É recuperável do banco: a origem (mesmo código, 'expandido_origem')
--      tem descrição NULL e não foi escrita desde a expansão (atualizado_em = criado_em da filha:
--      a última escrita dela é o UPDATE da própria expansão, que não toca a descrição), e a
--      observação da filha registra a variante gravada. Logo o original da filha é NULL. A
--      migration TRAVA as 17 linhas, CONFERE essas provas linha a linha e aborta se alguma não
--      valer mais; a POS exige as 12 presentes e com o original.
--   FICAM FORA (o original não é recuperável do banco — só lendo o arquivo-fonte da campanha):
--   as 13 filhas da campanha 23 (escritor ad-hoc fora do código, 2026-05-13: sem observação que
--   prove a variante), as 13 'manual_confirmado' (ids 119 e 151-162) e as 3 'unico' (5, 133, 134).
--   Seguem com o texto do catálogo; a lista e a procedência estão no diário.
--
-- Prova: db/test-promocao-descricao-fornecedor.sh (PG17 sobre o schema-snapshot de 2026-10-09,
-- predecessores = corpos de prod por md5; o defeito reproduz antes; PRE/POS e o manifesto
-- exercitados; a chamada do front e a do converter como authenticated; --falsificar).
-- Aplicação: bun run db:aplicar (envelope: CREATE OR REPLACE + UPDATE idempotente com PRE/POS) —
-- sem BEGIN/COMMIT no arquivo (a transação é do executor; colado inteiro no SQL Editor, roda numa
-- transação implícita). Re-aplicar é no-op: a PRE aceita o corpo desta migration e o backfill
-- pula a filha já saneada sem tocá-la (o trigger renovaria atualizado_em).
-- Reverter = migration compensatória com os 2 corpos de prod de 2026-10-10 e, se for o caso, o
-- manifesto ao contrário (os valores "antes" estão no backfill abaixo).

-- TRAVA, antes de ler: ALTER sem efeito em cada função que este arquivo recria (as duas são
-- VOLATILE em prod). Um CREATE OR REPLACE concorrente espera esta transação.
DO $trava$
BEGIN
  IF to_regprocedure('public.expandir_promocao_item(bigint,numeric)') IS NOT NULL THEN
    ALTER FUNCTION public.expandir_promocao_item(bigint, numeric) VOLATILE;
  END IF;
  IF to_regprocedure('public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.converter_sugestao_em_campanha_flat(bigint, numeric, numeric, text, date, text, text, text, text) VOLATILE;
  END IF;
END
$trava$;

-- PRE: o corpo vivo de cada uma é o de prod medido ou JÁ o desta migration (re-aplicar). Ausente
-- aborta. Guarda OID e ACL para a POS (CREATE OR REPLACE preserva os dois; DROP+CREATE não).
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, p.oid, md5(p.prosrc) AS vivo, x.predecessor, x.este, x.chave
      FROM (VALUES
        ('public.expandir_promocao_item(bigint,numeric)', '566edd782fb00616c6d658b9562020d2', '76b6e55a3d0c419b3ec39ba67cf1795a', 'expandir'),
        ('public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text,text)', '557f962e0355b034097be8cf88c27a1a', '73b8588851724e8c2aee0be7f4d3f457', 'converter')
      ) AS x(alvo, predecessor, este, chave)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(x.alvo)
  LOOP
    IF r.oid IS NULL THEN
      RAISE EXCEPTION 'PRE FALHOU: % ausente — a migration parte do corpo de prod', r.alvo;
    END IF;
    IF r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de % (md5 %) não é o de prod nem o desta migration — reconcilie antes', r.alvo, r.vivo;
    END IF;
    PERFORM set_config('promocao_descricao.' || r.chave,
      r.oid::text || '|' || (SELECT coalesce(p.proacl::text, 'ACL-DEFAULT') FROM pg_catalog.pg_proc p WHERE p.oid = r.oid), true);
  END LOOP;
END
$pre$;

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
        -- descricao_produto_fornecedor fica como o fornecedor ofertou (NULL inclusive): o SKU se lê pelo código
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
      -- a filha leva o texto que o FORNECEDOR ofertou (o da origem); o SKU dela se lê pelo código
      v_item.campanha_id, v_item.sku_codigo_fornecedor, v_item.descricao_produto_fornecedor,
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

CREATE OR REPLACE FUNCTION public.converter_sugestao_em_campanha_flat(p_sugestao_id bigint, p_desconto_perc numeric, p_volume_minimo numeric, p_volume_unidade text, p_data_fim date, p_sku_codigo_fornecedor text, p_responsavel_nome text DEFAULT NULL::text, p_canal text DEFAULT 'ligacao'::text, p_observacoes text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sugestao record;
  v_campanha_id bigint;
  -- o dia de SÃO PAULO: o instante da transação levado à data de SP (a sessão da prod é UTC)
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_codigo text := nullif(btrim(p_sku_codigo_fornecedor), '');
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  IF v_codigo IS NULL THEN
    RAISE EXCEPTION 'Informe o código Sayerlack do produto' USING ERRCODE = '22023';
  END IF;
  IF p_data_fim IS NULL OR p_data_fim < v_hoje THEN
    RAISE EXCEPTION 'A data fim (%) não pode ser anterior a hoje (%)', p_data_fim, v_hoje USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_sugestao FROM sugestao_negociacao_paralela WHERE id = p_sugestao_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sugestão % não encontrada', p_sugestao_id; END IF;
  IF v_sugestao.campanha_id_gerada IS NOT NULL THEN
    RAISE EXCEPTION 'Sugestão % já foi convertida na campanha %', p_sugestao_id, v_sugestao.campanha_id_gerada;
  END IF;
  IF v_sugestao.sku_codigo_omie !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'O SKU % da sugestão não é um código Omie numérico', v_sugestao.sku_codigo_omie USING ERRCODE = '22023';
  END IF;
  INSERT INTO promocao_campanha (
    empresa, fornecedor_nome, nome, tipo_origem, estado,
    data_inicio, data_fim, data_corte_pedido, data_corte_faturamento,
    responsavel_oferta_nome, canal_oferta, data_oferta,
    volume_minimo_condicional, volume_minimo_unidade,
    status_aceite, observacoes_negociacao, permite_pedido_oportunidade
  ) VALUES (
    v_sugestao.empresa, 'RENNER SAYERLACK S/A',
    format('Desconto Flat Condicional - %s', v_sugestao.sku_codigo_omie),
    'desconto_flat_condicional', 'negociando',
    v_hoje, p_data_fim, p_data_fim,
    (date_trunc('month', p_data_fim::timestamp) + interval '2 months - 1 day')::date,
    p_responsavel_nome, p_canal, v_hoje,
    p_volume_minimo, p_volume_unidade,
    'aceita', p_observacoes, false
  ) RETURNING id INTO v_campanha_id;
  -- descricao_produto_fornecedor fica NULL: a negociação não traz texto do fornecedor, e a
  -- descrição do SKU se lê pelo sku_codigo_omie
  INSERT INTO promocao_item (
    campanha_id, sku_codigo_fornecedor, sku_codigo_omie,
    mapeamento_qualidade, desconto_perc, confirmado, ativo, observacoes
  ) VALUES (
    v_campanha_id, v_codigo, v_sugestao.sku_codigo_omie::bigint,
    'manual_confirmado', p_desconto_perc, true, true,
    format('Convertido da sugestão de negociação paralela #%s', p_sugestao_id)
  );
  UPDATE sugestao_negociacao_paralela
  SET status = 'fechada_desconto', campanha_id_gerada = v_campanha_id,
      data_acao = now(), observacoes = p_observacoes, atualizado_em = now()
  WHERE id = p_sugestao_id;
  RETURN v_campanha_id;
END;
$function$;

-- Backfill por MANIFESTO FECHADO: (filha, origem, descrição de catálogo que a filha tem hoje).
-- Cada linha só muda se TODAS as provas do original valem agora; senão a migration inteira aborta
-- (funções incluídas). Filha já saneada (NULL) é pulada sem UPDATE.
-- As 17 linhas (12 filhas + 5 origens) são TRAVADAS antes de qualquer prova ser lida, em ordem de id:
-- sem a trava, uma transação concorrente que mudasse a observação ou a origem (sem tocar a descrição)
-- deixaria a prova vencida e o UPDATE seguiria mesmo assim (Codex P1; prova M9).
DO $backfill$
DECLARE
  r record;
BEGIN
  PERFORM 1 FROM public.promocao_item
   WHERE id IN (1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18)
   ORDER BY id
     FOR UPDATE;
  FOR r IN
    SELECT m.filha, m.origem, m.antes,
           f.id AS f_id, f.campanha_id AS f_campanha, f.sku_codigo_fornecedor AS f_codigo,
           f.mapeamento_qualidade AS f_qualidade, f.descricao_produto_fornecedor AS f_descricao,
           f.observacoes AS f_observacoes, f.criado_em AS f_criado_em,
           o.id AS o_id, o.campanha_id AS o_campanha, o.sku_codigo_fornecedor AS o_codigo,
           o.mapeamento_qualidade AS o_qualidade, o.descricao_produto_fornecedor AS o_descricao,
           o.atualizado_em AS o_atualizado_em
      FROM (VALUES
        (7, 1, 'THINNER DR.4403L5'),
        (8, 1, 'THINNER DR.4403LT'),
        (9, 1, 'THINNER DR.4403QT'),
        (10, 2, 'PRIMER PU BRANCO FL.6269.02BD'),
        (11, 2, 'PRIMER PU BRANCO FL.6269.02GL'),
        (12, 2, 'PRIMER PU BRANCO FL.6269.02QT'),
        (13, 3, 'PRIMER PU BRANCO FL.6264.02KGBH'),
        (14, 3, 'PRIMER PU BRANCO FL.6264.02QT'),
        (15, 6, 'PRIMER BA NEUTRO YL.5591.NTRBP'),
        (16, 6, 'PRIMER BA NEUTRO YL.5591.NTRGL'),
        (17, 4, 'F ACAB BASE AGUA YLO1.1118.00GL'),
        (18, 4, 'F ACAB BASE AGUA YLO1.1118.00QT')
      ) AS m(filha, origem, antes)
      LEFT JOIN public.promocao_item f ON f.id = m.filha
      LEFT JOIN public.promocao_item o ON o.id = m.origem
     ORDER BY m.filha
  LOOP
    IF r.f_id IS NULL OR r.o_id IS NULL THEN
      RAISE EXCEPTION 'BACKFILL FALHOU: a filha % ou a origem % não existe', r.filha, r.origem;
    END IF;
    IF r.f_campanha IS DISTINCT FROM 1 OR r.o_campanha IS DISTINCT FROM 1
       OR r.f_codigo IS DISTINCT FROM r.o_codigo
       OR r.f_qualidade IS DISTINCT FROM 'expandido_automatico'
       OR r.o_qualidade IS DISTINCT FROM 'expandido_origem' THEN
      RAISE EXCEPTION 'BACKFILL FALHOU: a filha % não é mais a expansão da origem % (campanha, código ou qualidade mudou)', r.filha, r.origem;
    END IF;
    IF position(format('[Expandido automaticamente do código %s — variante: %s]', r.o_codigo, r.antes)
                IN coalesce(r.f_observacoes, '')) = 0 THEN
      RAISE EXCEPTION 'BACKFILL FALHOU: a observação da filha % não registra a variante do manifesto', r.filha;
    END IF;
    IF r.o_descricao IS NOT NULL OR r.o_atualizado_em IS DISTINCT FROM r.f_criado_em THEN
      RAISE EXCEPTION 'BACKFILL FALHOU: a origem % foi escrita depois da expansão — o original da filha % não está mais provado', r.origem, r.filha;
    END IF;
    IF r.f_descricao IS NULL THEN
      CONTINUE;
    END IF;
    IF r.f_descricao IS DISTINCT FROM r.antes THEN
      RAISE EXCEPTION 'BACKFILL FALHOU: a filha % não tem mais a descrição do manifesto — alguém a editou; reconcilie antes', r.filha;
    END IF;
    UPDATE public.promocao_item
       SET descricao_produto_fornecedor = r.o_descricao
     WHERE id = r.filha AND descricao_produto_fornecedor = r.antes;
  END LOOP;
END
$backfill$;

-- POS: os dois corpos são ESTES (md5), com os mesmos atributos, OID e ACL de antes; e as 12 filhas do
-- manifesto estão PRESENTES e com o original (NULL) — contar só as com texto passaria por ausência.
DO $pos$
DECLARE
  r record;
  n int;
  n_original int;
BEGIN
  FOR r IN
    SELECT x.alvo, x.este, x.chave, x.secdef, x.config, p.oid, md5(p.prosrc) AS vivo, p.prosecdef,
           p.provolatile, array_to_string(p.proconfig, ';') AS cfg, pg_catalog.pg_get_userbyid(p.proowner) AS dono,
           coalesce(p.proacl::text, 'ACL-DEFAULT') AS acl
      FROM (VALUES
        ('public.expandir_promocao_item(bigint,numeric)', '76b6e55a3d0c419b3ec39ba67cf1795a', 'expandir', false, 'search_path=public, pg_temp'),
        ('public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text,text)', '73b8588851724e8c2aee0be7f4d3f457', 'converter', true, 'search_path=public')
      ) AS x(alvo, este, chave, secdef, config)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(x.alvo)
  LOOP
    IF r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'POS1 FALHOU: o corpo instalado de % (md5 %) não é o desta migration', r.alvo, r.vivo;
    END IF;
    IF r.prosecdef IS DISTINCT FROM r.secdef OR r.provolatile IS DISTINCT FROM 'v'
       OR r.cfg IS DISTINCT FROM r.config OR r.dono IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION 'POS2 FALHOU: % mudou de atributo (security definer, volatilidade, search_path ou dono)', r.alvo;
    END IF;
    IF r.oid::text || '|' || r.acl IS DISTINCT FROM current_setting('promocao_descricao.' || r.chave, true) THEN
      RAISE EXCEPTION 'POS3 FALHOU: % trocou de OID ou de ACL (DROP+CREATE ou GRANT/REVOKE no caminho)', r.alvo;
    END IF;
  END LOOP;
  SELECT count(*), count(*) FILTER (WHERE descricao_produto_fornecedor IS NULL) INTO n, n_original
    FROM public.promocao_item
   WHERE id IN (7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18);
  IF n IS DISTINCT FROM 12 OR n_original IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'POS4 FALHOU: das 12 filhas do manifesto, % presentes e % com o original (NULL)', n, n_original;
  END IF;
  RAISE NOTICE 'POS OK: os 2 corpos, atributos, OID e ACL conferidos; manifesto de 12 filhas saneado';
END
$pos$;
