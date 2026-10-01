-- 20260929000234_padrao_like_contem_escapa_curinga.sql
-- ============================================================
-- Classe `pattern-like-cru`, camada SQL: pattern de LIKE/ILIKE montado com um valor que devia casar
-- LITERAL, sem escapar os curingas. `%`/`_` do termo viram curinga e o termo vazio vira `%%`, que casa
-- tudo. A camada supabase-js de src/ fechou no #2627 (ilikeContainsPattern + ESLint); esta é a das
-- RPCs, que o semgrep não lê e o ESLint não vê. Registro: docs/agent/database.md §5 e
-- docs/historico/like-cru-camada-sql.md.
-- ============================================================
-- Censo em PROD (psql-ro, 2026-09-28): 11 funções com LIKE/ILIKE/~~/SIMILAR TO de lado direito
-- não-literal, em todo schema não-sistema, mais policies, views, matviews, cron, CHECK e índices.
--   AFETADAS, corrigidas aqui (o corpo é o de PROD, e só a linha do LIKE muda):
--     · listar_skus_por_codigo_fornecedor, resolver_sku_por_codigo_fornecedor (código de fornecedor,
--       invoker) e expandir_promocao_item(bigint,numeric), que conta pela primeira e expande por um
--       ILIKE próprio. O LIKE decide qual SKU é AUTO-CONFIRMADO no item da promoção: `AB_12` casava
--       `AB-12` e `ABX12`. Precisa mudar junto com listar_skus, senão contagem e expansão divergem.
--       O overload (bigint) só delega a listar_skus e não muda.
--     · melhoria_clientes_por_produto, melhoria_produtos_relacionados (termo da LLM da triagem): o
--       piso "mínimo 3 caracteres" é furado por `%%%`, que passa no length e casa tudo.
--     · tarefas_matcher_tick: o target_texto da tarefa contra as entidades da ligação. Vazio casava
--       qualquer produto citado ("Mencionou na ligação: X" falso).
--     · buscar_skus_candidatos: já escapava o curinga (era o modelo), mas o termo '' ou ' ' no array
--       virava `%%`/`% %`, quase match-all (LIMIT 100).
--   melhoria_clientes_por_produto leva também as 3 trocas de fuso da classe "hoje da sessão UTC"
--   (so.created_at::date ×2 e current_date ×1, agora lidos no fuso de SP): a sessão dessa classe as
--   tirou da migration dela (20260929001651) para as duas não recriarem a mesma função, onde a última
--   a rodar vence. A prod roda sessão UTC: das 21:00 às 23:59 BRT o current_date já é amanhã.
--   Dado vivo HOJE: 0 códigos de fornecedor com `%`/`_`/`\` (151 itens), 0 tarefas com target_texto,
--   0 chamadas da tool de dados da triagem. É brecha latente: o conserto não muda resultado atual.
--   FALSO-POSITIVO da assinatura (não mudam):
--     · radar_atribuir_tarefa: p_cnpj passa por `!~ '^[0-9]{14}$'` (RAISE) antes do LIKE.
--     · radar_contagem_por_municipio: p_cnae_prefix passa por `!~ '^[0-9]{1,7}$'` (RAISE) antes.
--     · reposicao_alerta_pedido_minimo_tick: `ILIKE v_fornecedor`, que vem da chave
--       `reposicao_alerta_pedido_fornecedor_ilike` de company_config: é pattern POR CONTRATO
--       (`%SAYERLACK%`, escrita só por master).
--     · _data_health_compute: o LIKE está em comentário e num literal de rótulo.
--     · 4 policies de farmer_algorithm_config: `LIKE 'margem!_faixa!_%' ESCAPE '!'`, literal.
--     · storage.*, realtime.*: código da plataforma.
-- O gate que torna a reintrodução vermelha: scripts/like-cru-em-migrations-gate.ts (CI).
--
-- O idioma: `<col> [I]LIKE private.padrao_like_contem(<termo>) ESCAPE '\'`, o espelho SQL do
-- ilikeContainsPattern de src/lib/postgrest.ts: o pattern de "contém" com `\`, `%` e `_` escapados, ou
-- NULL quando não há termo útil (nulo, vazio, só espaço, só curinga). `x ILIKE NULL` é NULL, e o WHERE
-- descarta a linha: o termo degenerado vira "nenhum resultado" por construção, nunca "tudo". Por isso
-- o helper, e não a cadeia replace() inline: a cadeia fecha o curinga e deixa o termo vazio aberto
-- (o caso do buscar_skus_candidatos).
-- EXECUTE do helper para PUBLIC é de propósito: é função pura, sem acesso a dado, e as três invoker
-- que o chamam são executáveis por PUBLIC em prod (inclusive o papel sandbox_exec do Lovable). ACL
-- mais estreita quebraria quem hoje as chama.
--
-- listar_skus e os dois expandir_promocao_item NUNCA tiveram CREATE commitado (só existem em prod e
-- no schema-snapshot). Esta migration é a primeira definição versionada de listar_skus e do overload
-- (bigint,numeric), e a partir dela o deriva:corpo:prod passa a vigiá-los.
--
-- Prova: db/test-padrao-like-contem.sh (PG17 sobre o schema-snapshot, com os corpos de PROD como
-- predecessores; negativos por curinga e por termo degenerado nas 7; PRE/POS exercitadas; --falsificar
-- com controle verde na mesma invocação, nos dois locales).
-- Aplicação: bun run db:aplicar. A transação é do executor, por isso não há BEGIN/COMMIT aqui.
-- Reverter depois do commit = migration compensatória nova com os corpos de prod de 2026-09-28.

CREATE OR REPLACE FUNCTION private.padrao_like_contem(p_termo text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = ''
AS $fn$
  SELECT CASE
    WHEN btrim(translate(p_termo, '%_', ''), E' \t\r\n') = '' THEN NULL
    ELSE '%' || replace(replace(replace(p_termo, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END
$fn$;

COMMENT ON FUNCTION private.padrao_like_contem(text) IS
  'Pattern de "contém" para [I]LIKE com \, % e _ do termo escapados, ou NULL quando o termo não tem '
  'conteúdo útil (nulo, vazio, só espaço, só curinga). Uso: col ILIKE private.padrao_like_contem(t) '
  'ESCAPE ''\''. NULL faz o LIKE não casar nada. Espelho SQL do ilikeContainsPattern '
  '(src/lib/postgrest.ts). Classe pattern-like-cru: docs/agent/database.md §5.';

GRANT EXECUTE ON FUNCTION private.padrao_like_contem(text) TO PUBLIC;

-- Pré-condição, função a função: o corpo vivo tem de ser o de PROD medido em 2026-09-28 (md5 EXATO do
-- prosrc; o db:aplicar transporta os bytes verbatim) ou JÁ o desta migration (re-aplicar é seguro).
-- Qualquer outro corpo é mudança concorrente que o CREATE OR REPLACE apagaria em silêncio, então
-- aborta. Função ausente também aborta.
-- A linha de pg_proc é TRAVADA antes da leitura (ALTER com o MESMO search_path; padrão da
-- 20260927195430): outro aplicador que commitasse entre a leitura e o CREATE teria o corpo sobrescrito
-- em silêncio; com a trava ele espera esta transação e falha. A trava tem de ser no-op: a config lida
-- antes e depois do ALTER tem de ser a mesma e a esperada, senão o ALTER teria mudado algo, e aborta.
DO $pre$
DECLARE
  r record;
  v_antes text[];
  v_depois text[];
  v_md5 text;
BEGIN
  FOR r IN
    SELECT *
      FROM (VALUES
        ('public.listar_skus_por_codigo_fornecedor(text,text)', 'public, pg_temp', '1016c3a5578ad0279b7b5da787ebc1c4', 'dde6bdf77b96f103c99b2699ac33207f'),
        ('public.resolver_sku_por_codigo_fornecedor(text,text)', 'public, pg_temp', '774dfc823a3ac3a736d844502776db85', 'c1ec2e9cdd4899d64563299da4d987a1'),
        ('public.expandir_promocao_item(bigint,numeric)',        'public, pg_temp', '9f56c82cb202725335680b196cd44ec5', 'bc8f2c0e7a85ccdf89b5e5cd59b84e38'),
        ('public.buscar_skus_candidatos(text[])',                'public',          '3889779055fe534d9f125f7c3fc50e7f', 'fe6a391c0ed72782d02b3404af6b73c8'),
        ('public.melhoria_clientes_por_produto(text)',           'public, private', 'b482c18e67700353359012ca4a027ad6', 'fb00b17ac45b38e31a08fe4531c51618'),
        ('public.melhoria_produtos_relacionados(text)',          'public',          'f9bfbe39ab5bcc35a93bb09ddfb8bc56', 'b7ea8d9ef3a5e7cfdcfd4a611956affd'),
        ('public.tarefas_matcher_tick()',                        'public',          'be66e0548a5771d0956dca78f24df7ea', '8359601c131e59f8681ba2e4dd228d6b')
      ) AS a(ident, sp, md5_prod, md5_novo)
  LOOP
    IF to_regprocedure(r.ident) IS NULL THEN
      RAISE EXCEPTION 'PRE FALHOU: % ausente. Esta migration substitui o corpo de prod medido em 2026-09-28; reconcilie antes de aplicar', r.ident;
    END IF;
    SELECT p.proconfig INTO v_antes FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.ident);
    EXECUTE format('ALTER FUNCTION %s SET search_path = %s', r.ident, r.sp);
    SELECT p.proconfig, md5(p.prosrc)
      INTO v_depois, v_md5
      FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure(r.ident);
    IF v_antes IS DISTINCT FROM v_depois OR v_depois IS DISTINCT FROM ARRAY['search_path=' || r.sp] THEN
      RAISE EXCEPTION 'PRE FALHOU: a config de % era % e a trava a deixou em %. A trava tem de ser no-op (esperado search_path=%)', r.ident, v_antes, v_depois, r.sp;
    END IF;
    IF v_md5 IS NULL OR v_md5 NOT IN (r.md5_prod, r.md5_novo) THEN
      RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de % (md5 %) não é o de prod medido em 2026-09-28 nem o desta migration. Outra mudança chegou antes; reconcilie antes de aplicar', r.ident, v_md5;
    END IF;
  END LOOP;
END
$pre$;

-- As 7 funções: o corpo de PROD (pg_get_functiondef, 2026-09-28) com só a linha do LIKE trocada.

CREATE OR REPLACE FUNCTION public.listar_skus_por_codigo_fornecedor(p_empresa text, p_codigo_fornecedor text)
 RETURNS TABLE(omie_codigo_produto bigint, codigo_interno text, descricao text, familia text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT 
    op.omie_codigo_produto,
    op.codigo,
    op.descricao,
    op.familia
  FROM omie_products op
  WHERE LOWER(op.account) = LOWER(p_empresa)
    AND COALESCE(op.ativo, true) = true
    AND p_codigo_fornecedor IS NOT NULL
    AND TRIM(p_codigo_fornecedor) <> ''
    AND op.descricao ILIKE private.padrao_like_contem(p_codigo_fornecedor) ESCAPE '\'
  ORDER BY op.descricao;
$function$;

CREATE OR REPLACE FUNCTION public.resolver_sku_por_codigo_fornecedor(p_empresa text, p_codigo_fornecedor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count int;
  v_unico record;
  v_candidatos jsonb;
  v_empresa text := lower(coalesce(p_empresa, ''));
BEGIN
  IF p_codigo_fornecedor IS NULL OR TRIM(p_codigo_fornecedor) = '' THEN
    RETURN jsonb_build_object('qualidade', 'nao_encontrado', 'motivo', 'codigo_vazio');
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM omie_products op
  WHERE lower(op.account) = v_empresa
    AND COALESCE(op.ativo, true) = true
    AND op.descricao ILIKE private.padrao_like_contem(p_codigo_fornecedor) ESCAPE '\';

  IF v_count = 0 THEN
    RETURN jsonb_build_object('qualidade', 'nao_encontrado');
  END IF;

  IF v_count = 1 THEN
    SELECT op.omie_codigo_produto, op.descricao INTO v_unico
    FROM omie_products op
    WHERE lower(op.account) = v_empresa
      AND COALESCE(op.ativo, true) = true
      AND op.descricao ILIKE private.padrao_like_contem(p_codigo_fornecedor) ESCAPE '\'
    LIMIT 1;

    RETURN jsonb_build_object(
      'qualidade', 'unico',
      'omie_codigo_produto', v_unico.omie_codigo_produto,
      'descricao', v_unico.descricao
    );
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'omie_codigo_produto', op.omie_codigo_produto,
      'descricao', op.descricao,
      'codigo_interno', op.codigo
    )
    ORDER BY op.descricao
  )
  INTO v_candidatos
  FROM (
    SELECT omie_codigo_produto, descricao, codigo
    FROM omie_products
    WHERE lower(account) = v_empresa
      AND COALESCE(ativo, true) = true
      AND descricao ILIKE private.padrao_like_contem(p_codigo_fornecedor) ESCAPE '\'
    LIMIT 5
  ) op;

  RETURN jsonb_build_object(
    'qualidade', 'ambiguo',
    'total_matches', v_count,
    'candidatos', v_candidatos
  );
END;
$function$;

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
    SELECT MAX(similarity(op.descricao, v_item.sku_codigo_fornecedor))
    INTO v_similar_max
    FROM omie_products op
    WHERE LOWER(op.account) = LOWER(v_item.empresa) AND COALESCE(op.ativo, true) = true;

    IF v_similar_max >= p_threshold_similaridade THEN
      v_usou_similaridade := true;
      SELECT COUNT(*) INTO v_variantes_count
      FROM omie_products op
      WHERE LOWER(op.account) = LOWER(v_item.empresa)
        AND COALESCE(op.ativo, true) = true
        AND similarity(op.descricao, v_item.sku_codigo_fornecedor) >= p_threshold_similaridade;
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
        AND similarity(op.descricao, v_item.sku_codigo_fornecedor) >= p_threshold_similaridade
      ORDER BY similarity(op.descricao, v_item.sku_codigo_fornecedor) DESC LIMIT 1;
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
                THEN similarity(op.descricao, v_item.sku_codigo_fornecedor) >= p_threshold_similaridade
                ELSE op.descricao ILIKE private.padrao_like_contem(v_item.sku_codigo_fornecedor) ESCAPE '\' END)
    ORDER BY op.descricao
  LOOP
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

CREATE OR REPLACE FUNCTION public.buscar_skus_candidatos(p_termos text[])
 RETURNS TABLE(account text, omie_codigo_produto bigint, codigo text, descricao text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'employee'::app_role)
       OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_termos IS NULL OR array_length(p_termos, 1) IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT op.account, op.omie_codigo_produto, op.codigo, op.descricao
  FROM public.omie_products op
  WHERE op.ativo IS NOT FALSE
    AND EXISTS (
      SELECT 1 FROM unnest(p_termos) t
      WHERE upper(op.descricao) LIKE
        private.padrao_like_contem(upper(t)) ESCAPE '\'
    )
  ORDER BY op.account, op.descricao
  LIMIT 100;
END;
$function$;

CREATE OR REPLACE FUNCTION public.melhoria_clientes_por_produto(p_termo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_full boolean;
  v_result jsonb;
begin
  if v_uid is null or not (has_role(v_uid,'employee'::app_role) or has_role(v_uid,'master'::app_role)) then
    raise exception 'Apenas staff pode consultar';
  end if;
  if length(trim(coalesce(p_termo,''))) < 3 then
    raise exception 'Termo de busca muito curto (mínimo 3 caracteres)';
  end if;
  v_full := pode_ver_carteira_completa(v_uid);

  with prods as (
    select id, descricao, codigo, account
    from omie_products
    where coalesce(ativo, true) = true
      and (descricao ilike private.padrao_like_contem(trim(p_termo)) escape '\' or codigo ilike private.padrao_like_contem(trim(p_termo)) escape '\')
    order by descricao
    limit 5
  ),
  compras as (
    select oi.customer_user_id,
           count(distinct oi.sales_order_id) as n_pedidos,
           max(coalesce(so.order_date_kpi, (so.created_at at time zone 'America/Sao_Paulo')::date)) as ultima_compra,
           sum(oi.quantity * oi.unit_price) as valor_12m
    from order_items oi
    join sales_orders so on so.id = oi.sales_order_id
    join prods p on p.id = oi.product_id
    where so.status not in ('cancelado','rascunho','pendente')
      and so.deleted_at is null
      and coalesce(so.order_date_kpi, (so.created_at at time zone 'America/Sao_Paulo')::date) >= (now() at time zone 'America/Sao_Paulo')::date - interval '12 months'
    group by oi.customer_user_id
  ),
  visiveis as (
    select c.* from compras c
    where v_full or carteira_visivel_para(c.customer_user_id, v_uid)
  ),
  top50 as (
    -- NULLS LAST e OBRIGATORIO desde que order_items.unit_price virou nullable
    -- (20260905225613): `sum(quantity * unit_price)` devolve NULL quando NENHUM item do
    -- cliente tem preco conhecido, e o default do Postgres em DESC e NULLS **FIRST** —
    -- medido: `ORDER BY v DESC` sobre (1,NULL,5) devolve NULL,5,1. Sem isto, o cliente
    -- de quem NAO SE SABE a receita encabecaria o top-50 de melhoria, invertendo a
    -- ordem que a tela usa para decidir quem visitar. "Nao sei" nao e "o maior".
    select * from visiveis order by valor_12m desc nulls last limit 50
  )
  select jsonb_build_object(
    'produtos_casados', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'account', account)), '[]'::jsonb) from prods),
    'clientes', (select coalesce(jsonb_agg(jsonb_build_object(
        'cliente', coalesce(pr.razao_social, pr.name),
        'n_pedidos', t.n_pedidos,
        'ultima_compra', t.ultima_compra,
        'valor_12m', round(t.valor_12m::numeric, 2)
      ) order by t.valor_12m desc nulls last), '[]'::jsonb)
      from top50 t join profiles pr on pr.user_id = t.customer_user_id),
    'total_clientes_visiveis', (select count(*) from visiveis),
    'escopo', case when v_full then 'todos' else 'minha_carteira' end
  ) into v_result;

  return v_result;
end $function$;

CREATE OR REPLACE FUNCTION public.melhoria_produtos_relacionados(p_termo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null or not (has_role(v_uid,'employee'::app_role) or has_role(v_uid,'master'::app_role)) then
    raise exception 'Apenas staff pode consultar';
  end if;
  if length(trim(coalesce(p_termo,''))) < 3 then
    raise exception 'Termo de busca muito curto (mínimo 3 caracteres)';
  end if;

  with alvo as (
    select id, descricao, codigo, familia, account
    from omie_products
    where coalesce(ativo, true) = true
      and (descricao ilike private.padrao_like_contem(trim(p_termo)) escape '\' or codigo ilike private.padrao_like_contem(trim(p_termo)) escape '\')
    order by descricao
    limit 5
  ),
  mesma_familia as (
    select distinct op.descricao, op.codigo, op.familia
    from omie_products op
    join alvo a on a.familia is not null and op.familia = a.familia and op.account = a.account
    where coalesce(op.ativo, true) = true
      and op.id not in (select id from alvo)
    limit 10
  ),
  regras as (
    select cons_id, max(r.confidence) as confidence, max(r.lift) as lift
    from farmer_association_rules r
    cross join lateral unnest(r.consequent_product_ids::text[]) as cons_id
    where exists (select 1 from alvo a where a.id::text = any(r.antecedent_product_ids::text[]))
    group by cons_id
    order by max(r.lift) desc
    limit 10
  ),
  comprados_juntos as (
    select op.descricao, op.codigo, round(r.confidence::numeric, 3) as confidence, round(r.lift::numeric, 2) as lift
    from regras r
    join omie_products op on op.id::text = r.cons_id
    where coalesce(op.ativo, true) = true
      and op.id not in (select id from alvo)
  )
  select jsonb_build_object(
    'produtos_casados', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'account', account)), '[]'::jsonb) from alvo),
    'mesma_familia', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'familia', familia)), '[]'::jsonb) from mesma_familia),
    'comprados_juntos', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'confidence', confidence, 'lift', lift)), '[]'::jsonb) from comprados_juntos)
  ) into v_result;

  return v_result;
end $function$;

CREATE OR REPLACE FUNCTION public.tarefas_matcher_tick()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  with fechadas as (
    update public.tarefas t
    set status='concluida', concluida_em=now(), conclusao_origem='auto_interacao', updated_at=now()
    from public.farmer_calls fc
    where t.status='aberta' and t.auto_satisfy_mode='interacao' and t.interacao_tipo='ligacao'
      and fc.customer_user_id = t.customer_user_id
      and fc.created_at > t.created_at
      and fc.created_at > now() - interval '1 day'
      and fc.call_result is not null
      and fc.call_result not in ('sem_resposta','ocupado','caixa_postal','numero_invalido')
      and ( fc.farmer_id = t.assigned_to
            or exists (select 1 from public.carteira_coverage cc
                       where cc.covered_user_id=t.assigned_to and cc.covering_user_id=fc.farmer_id
                         and cc.active and now()>=cc.valid_from and (cc.valid_until is null or now()<=cc.valid_until)) )
    returning t.id, t.assigned_to, fc.id as fonte, fc.farmer_id as fechou
  )
  insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
  select id, 'concluida_auto', fechou,
         jsonb_build_object('via','ligacao','source_id',fonte,'responsavel_efetivo',fechou,'assigned_to',assigned_to)
  from fechadas;

  with fechadas_v as (
    update public.tarefas t
    set status='concluida', concluida_em=now(), conclusao_origem='auto_interacao', updated_at=now()
    from public.route_visits rv
    where t.status='aberta' and t.auto_satisfy_mode='interacao' and t.interacao_tipo in ('visita','entrega')
      and rv.customer_user_id = t.customer_user_id
      and rv.check_in_at > t.created_at
      and rv.check_in_at > now() - interval '1 day'
      and ( (t.interacao_tipo='visita' and rv.visit_type='comercial')
            or (t.interacao_tipo='entrega' and rv.visit_type='entrega') )
      and ( rv.visited_by = t.assigned_to
            or exists (select 1 from public.carteira_coverage cc
                       where cc.covered_user_id=t.assigned_to and cc.covering_user_id=rv.visited_by
                         and cc.active and now()>=cc.valid_from and (cc.valid_until is null or now()<=cc.valid_until)) )
    returning t.id, t.assigned_to, rv.id as fonte, rv.visited_by as fechou
  )
  insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
  select id, 'concluida_auto', fechou,
         jsonb_build_object('via','visita_entrega','source_id',fonte,'responsavel_efetivo',fechou,'assigned_to',assigned_to)
  from fechadas_v;

  with novos as (
    insert into public.tarefa_satisfacao_candidatos
      (tarefa_id, source_type, source_id, mode, confidence, motivo, matched_payload, status)
    select t.id, 'farmer_call', fc.id, 'conteudo',
           coalesce(m.confidence, 0.0),
           case when m.value is not null then 'Mencionou na ligação: '||m.value
                else 'Ligação aconteceu — confirmar se ofereceu' end,
           case when m.value is not null
                then jsonb_build_object('entity_type', m.etype, 'value', m.value, 'context', m.context)
                else null end,
           'pending'
    from public.tarefas t
    join public.farmer_calls fc
      on fc.customer_user_id = t.customer_user_id
     and fc.created_at > t.created_at
     and fc.created_at > now() - interval '1 day'
     and ( fc.farmer_id = t.assigned_to
           or exists (select 1 from public.carteira_coverage cc
                      where cc.covered_user_id=t.assigned_to and cc.covering_user_id=fc.farmer_id
                        and cc.active and now()>=cc.valid_from and (cc.valid_until is null or now()<=cc.valid_until)) )
    left join lateral (
      select e->>'value' as value, e->>'type' as etype, e->>'context' as context,
             (e->>'confidence')::numeric as confidence
      from jsonb_array_elements(coalesce(fc.entities_extracted, '[]'::jsonb)) e
      where e->>'type' in ('product','price')
        and t.target_texto is not null
        and e->>'value' ilike private.padrao_like_contem(t.target_texto) escape '\'
      order by (e->>'confidence')::numeric desc nulls last
      limit 1
    ) m on true
    where t.status='aberta' and t.auto_satisfy_mode='conteudo' and t.interacao_tipo='ligacao'
    on conflict (tarefa_id, source_type, source_id) do nothing
    returning tarefa_id, id
  )
  insert into public.tarefa_eventos (tarefa_id, tipo_evento, ator, payload)
  select tarefa_id, 'sugestao_criada', null, jsonb_build_object('candidato_id', id) from novos;

  update public.tarefa_satisfacao_candidatos
  set status='expired', resolved_at=now()
  where status='pending' and created_at < now() - interval '14 days';
end $function$;

-- Pós-condição. O helper é EXECUTADO (o contrato, não só a existência); depois, função a função, os
-- predicados semânticos vêm ANTES do md5. Depois dele seriam inalcançáveis, e a mensagem que diz O QUE
-- está errado se perderia. ACL: CREATE OR REPLACE preserva e DROP+CREATE reseta, então a fechada
-- que abrisse para anon, ou authenticated/service_role sem EXECUTE, é a marca de um DROP no caminho.
DO $post$
DECLARE
  r record;
  v_oid oid;
  v_src text;
  v_md5 text;
  v_n int;
  v_helper oid := to_regprocedure('private.padrao_like_contem(text)');
BEGIN
  IF v_helper IS NULL THEN
    RAISE EXCEPTION 'POS1 FALHOU: private.padrao_like_contem(text) não existe';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = v_helper AND p.provolatile = 'i' AND p.proisstrict AND NOT p.prosecdef
                    AND p.proconfig = ARRAY['search_path=""']) THEN
    RAISE EXCEPTION 'POS2 FALHOU: o helper tem de ser IMMUTABLE, STRICT, SECURITY INVOKER e com search_path vazio';
  END IF;
  IF private.padrao_like_contem('') IS NOT NULL OR private.padrao_like_contem('   ') IS NOT NULL
     OR private.padrao_like_contem('%') IS NOT NULL OR private.padrao_like_contem(' %_% ') IS NOT NULL THEN
    RAISE EXCEPTION 'POS3 FALHOU: termo degenerado devolveu pattern (casaria tudo) em vez de NULL';
  END IF;
  IF private.padrao_like_contem('a_b%c\d') IS DISTINCT FROM '%a\_b\%c\\d%' THEN
    RAISE EXCEPTION 'POS4 FALHOU: escape errado: %', private.padrao_like_contem('a_b%c\d');
  END IF;
  IF NOT ('xa_b%c\dy' ILIKE private.padrao_like_contem('A_B%C\D') ESCAPE '\')
     OR ('xaXb%c\dy' ILIKE private.padrao_like_contem('a_b%c\d') ESCAPE '\')
     OR ('xa_bYc\dy' ILIKE private.padrao_like_contem('a_b%c\d') ESCAPE '\') THEN
    RAISE EXCEPTION 'POS5 FALHOU: o pattern não casa o literal, ou casa com o curinga interpretado';
  END IF;
  IF NOT pg_catalog.has_function_privilege('public', v_helper, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS6 FALHOU: helper sem EXECUTE para PUBLIC. As RPCs invoker que o chamam quebrariam';
  END IF;

  FOR r IN
    SELECT *
      FROM (VALUES
        ('public.listar_skus_por_codigo_fornecedor(text,text)', 1, 'dde6bdf77b96f103c99b2699ac33207f', false, 's', 'public, pg_temp', false),
        ('public.resolver_sku_por_codigo_fornecedor(text,text)', 3, 'c1ec2e9cdd4899d64563299da4d987a1', false, 's', 'public, pg_temp', false),
        ('public.expandir_promocao_item(bigint,numeric)',        1, 'bc8f2c0e7a85ccdf89b5e5cd59b84e38', false, 'v', 'public, pg_temp', false),
        ('public.buscar_skus_candidatos(text[])',                1, 'fe6a391c0ed72782d02b3404af6b73c8', true,  'v', 'public',          true),
        ('public.melhoria_clientes_por_produto(text)',           2, 'fb00b17ac45b38e31a08fe4531c51618', true,  's', 'public, private', true),
        ('public.melhoria_produtos_relacionados(text)',          2, 'b7ea8d9ef3a5e7cfdcfd4a611956affd', true,  's', 'public',          true),
        ('public.tarefas_matcher_tick()',                        1, '8359601c131e59f8681ba2e4dd228d6b', true,  'v', 'public',          true)
      ) AS a(ident, n_sitios, md5_novo, secdef, vol, sp, fechada)
  LOOP
    v_oid := to_regprocedure(r.ident);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'POS7 FALHOU: % não existe', r.ident;
    END IF;
    SELECT p.prosrc, md5(p.prosrc) INTO v_src, v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
    SELECT count(*) INTO v_n
      FROM regexp_matches(v_src, 'private\.padrao_like_contem\((?:[^()]|\([^()]*\))*\)\s+escape\s+''\\''', 'gi') AS m;
    IF v_n <> r.n_sitios THEN
      RAISE EXCEPTION 'POS8 FALHOU: % tem % sítio(s) com helper + ESCAPE, esperado %', r.ident, v_n, r.n_sitios;
    END IF;
    IF v_src ~* '\mi?like\s+''%''\s*\|\|' OR v_src ~* '''%''\s*\|\|\s*replace\s*\(' THEN
      RAISE EXCEPTION 'POS9 FALHOU: sobrou pattern montado cru em %', r.ident;
    END IF;
    IF v_md5 IS DISTINCT FROM r.md5_novo THEN
      RAISE EXCEPTION 'POS10 FALHOU: o corpo instalado de % (md5 %) não é o desta migration', r.ident, v_md5;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                    WHERE p.oid = v_oid AND p.prosecdef = r.secdef AND p.provolatile = r.vol
                      AND p.proconfig = ARRAY['search_path=' || r.sp]
                      AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres') THEN
      RAISE EXCEPTION 'POS11 FALHOU: % mudou SECURITY, volatilidade, search_path ou dono', r.ident;
    END IF;
    IF NOT pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       OR (r.fechada AND pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'POS12 FALHOU: o ACL de % mudou (authenticated/service_role sem EXECUTE, ou a fechada abriu para anon). CREATE OR REPLACE preserva o ACL; DROP+CREATE não', r.ident;
    END IF;
  END LOOP;
  RAISE NOTICE 'POS OK: helper e as 7 funções com o pattern escapado; termo degenerado não casa nada';
END
$post$;
