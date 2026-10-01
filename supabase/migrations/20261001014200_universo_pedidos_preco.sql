-- 20261001014200_universo_pedidos_preco.sql
-- ============================================================
-- Preço (régua, régua 360, proposta de WhatsApp, últimos preços, abaixo do piso, defasagem, tint):
-- universo de pedidos CANÔNICO. A data de cada função NÃO muda — só o universo.
-- ============================================================
-- A classe e a autoridade: ver o cabeçalho de 20261001014000_universo_pedidos_caca.sql e
-- docs/historico/universo-pedidos-classe-sql.md.
--
-- Antes desta migration (prod, 2026-10-01), predicado sobre o alias de sales_orders:
--   · get_regua_preco (precos_cliente e comparaveis) e get_regua_preco_customer360 (produto e
--     preco_atual, que decide abaixo_piso): NENHUM filtro de status;
--   · get_whatsapp_proposta_cotacao (preço "praticado" da proposta que vai ao CLIENTE): nenhum filtro
--     de status NEM de deleted_at;
--   · get_ultimos_precos_cliente e medir_abaixo_piso_tier: COALESCE(status,'') NOT IN (cancelado,
--     orcamento) — rascunho e pendente entravam;
--   · get_defasagem_cliente: ALLOWLIST dos 4 de venda (igual hoje; diverge se surgir status novo);
--   · tint_ultimo_preco_cliente: status IS DISTINCT FROM 'cancelado', sem deleted_at.
--
-- Decisão do founder (2026-10-01): canônico nas 7. Efeito medido na prod (psql-ro, 2026-10-01 01:00
-- UTC; só os 28 pedidos cancelados importam — orçamento e rascunho não têm itens): régua — 33 itens de
-- cancelados na janela de 180 d, 28 de 2.388 pares cliente×produto (4 só com cancelado: precos_cliente
-- vira []), 27 de 448 produtos com cancelado nos comparáveis; 360 — em 14 de 7.294 pares o preco_atual
-- vinha de cancelado (11 mudam: 5 viram sem_preco, 6 outro preço); proposta — 14 de 24.093
-- (cliente, conta, sku) (11 mudam, 5 somem e caem para tabela ou sem_preco). As outras 4: 0 linhas.
--
-- Conserto: a ÚNICA mudança em cada corpo é o predicado do universo no alias so. O resto é o texto
-- VIVO da prod (pg_get_functiondef, 2026-10-01; a régua já com o fuso de SP da 20260929001651,
-- aplicada em 2026-10-01 00:58 UTC), gerado por troca exata com contagem conferida — mesmas
-- assinaturas, retornos, volatilidade, SECURITY DEFINER, search_path, dono e ACL (CREATE OR REPLACE
-- preserva OID e ACL). No tint, o omie_pedido_id IS NOT NULL e a janela de 180 d são regra própria
-- do acordo comercial e ficam.
--
-- Trava ANTES de ler: ALTER FUNCTION … <a mesma volatilidade> prende a linha de pg_proc (um CREATE
-- concorrente espera esta transação). Identidade (PRE e POS): md5 EXATO do prosrc — o db:aplicar
-- transporta os bytes verbatim. PRE aceita o predecessor medido ou este corpo; POS: semântica →
-- md5 → retrato (volatilidade|secdef|dono|proconfig e ACL) igual ao de antes.
-- Aplicação: `bun run db:aplicar <este arquivo> --ensaio`, depois sem --ensaio. Prova:
-- db/test-universo-pedidos-classe.sh.

ALTER FUNCTION public.get_regua_preco(uuid,uuid,numeric,numeric,numeric[]) VOLATILE;
ALTER FUNCTION public.get_regua_preco_customer360(uuid,bigint[]) VOLATILE;
ALTER FUNCTION public.get_whatsapp_proposta_cotacao(uuid,text,bigint[]) STABLE;
ALTER FUNCTION public.get_ultimos_precos_cliente(uuid) STABLE;
ALTER FUNCTION public.medir_abaixo_piso_tier(integer) STABLE;
ALTER FUNCTION public.get_defasagem_cliente(jsonb,uuid) STABLE;
ALTER FUNCTION public.tint_ultimo_preco_cliente(uuid,uuid,text,uuid) STABLE;

CREATE TEMP TABLE IF NOT EXISTS universo_retrato (alvo text PRIMARY KEY, config text NOT NULL, acl text NOT NULL) ON COMMIT DROP;

DO $pre$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.get_regua_preco(uuid,uuid,numeric,numeric,numeric[])', '846b8d591627674ff59b904b53222ff1', 'b07051bec32e32f6b40b1991a92f07df'),
      ('public.get_regua_preco_customer360(uuid,bigint[])', '92362d82b03f36e594664e16a334297c', '53c8cc09fdad207c8930384033a47a00'),
      ('public.get_whatsapp_proposta_cotacao(uuid,text,bigint[])', 'd73ff1824d15ec00b9e0c85091b9e3e7', 'bda0102ab47ca37b0ee126f5028233c8'),
      ('public.get_ultimos_precos_cliente(uuid)', '77a6962c6f62b1d82d1d31b43b38c5fc', 'd20fc5118db564025fc8e3aba8b67746'),
      ('public.medir_abaixo_piso_tier(integer)', '9fc343369c69aeeb510f67ec22037a12', '3f0e6844dbcea3bea8bf6a1aca5e0a30'),
      ('public.get_defasagem_cliente(jsonb,uuid)', '4ad3e130bdf9fda5546ced1450e7b6af', 'a03eb600ef0d2a946e550aa55bba415e'),
      ('public.tint_ultimo_preco_cliente(uuid,uuid,text,uuid)', '712b5761381bb0118c968e9ca56f282d', '0fc1c4b303dc6fcf39e2b57294ab130b')
    ) AS x(alvo, predecessor, este)
  LOOP
    IF to_regprocedure(r.alvo) IS NULL THEN
      RAISE EXCEPTION 'PRE: % ausente — esta migration exige o predecessor medido na prod', r.alvo;
    END IF;
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.alvo);
    IF v_md5 IS DISTINCT FROM r.predecessor AND v_md5 IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'PRE: % deriva — md5(prosrc)=% não é o predecessor (%) nem este corpo (%)', r.alvo, v_md5, r.predecessor, r.este;
    END IF;
    INSERT INTO pg_temp.universo_retrato
      SELECT r.alvo, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
             || coalesce(array_to_string(p.proconfig, ','), '-'), coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
        FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.alvo);
  END LOOP;
END $pre$;

-- public.get_regua_preco
CREATE OR REPLACE FUNCTION public.get_regua_preco(p_customer uuid, p_product uuid, p_qty numeric, p_preco_atual numeric, p_prazo_dias numeric[] DEFAULT NULL::numeric[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account      text := 'oben';
  v_cmc          numeric;
  v_aliquota     numeric;
  v_taxa         numeric;
  v_piso         numeric;   -- ÍNTEGRO: é o que decide `abaixo_piso`
  v_piso_exib    numeric;   -- APLICÁVEL: o mesmo piso arredondado p/ CIMA (ver abaixo)
  v_prazo_ok     boolean;
  v_abaixo       boolean;
  v_pode_num     boolean;
  v_precos_cli   numeric[];
  v_comparaveis  jsonb;
  -- p_qty não persiste, mas define a banda de comparáveis: não-finito faria BETWEEN sem sentido.
  v_qty_lo       numeric := CASE WHEN private.regua_num_finito(p_qty) THEN p_qty ELSE 0 END * 0.5;
  v_qty_hi       numeric := CASE WHEN private.regua_num_finito(p_qty) THEN p_qty ELSE 0 END * 2;
BEGIN
  -- gate de ENTRADA: somente staff (inalterado — a vendedora precisa do sinal)
  IF NOT (public.has_role((SELECT auth.uid()), 'employee') OR public.has_role((SELECT auth.uid()), 'master')) THEN
    RAISE EXCEPTION 'forbidden: regua_preco exige staff' USING ERRCODE = '42501';
  END IF;

  -- gate do NÚMERO: mesmo padrão de v_pode_num do get_preco_cockpit
  v_pode_num := private.cap_custo_ler((SELECT auth.uid()));

  -- CMC: account 'oben' preferido, fallback 'vendas' (espelhos)
  SELECT ip.cmc INTO v_cmc FROM public.inventory_position ip
   WHERE ip.product_id = p_product AND ip.account IN ('oben', 'vendas')
     AND private.regua_num_finito(ip.cmc) AND ip.cmc > 0
   ORDER BY (ip.account = 'oben') DESC LIMIT 1;

  SELECT COALESCE(
           (SELECT cc.value::numeric FROM public.company_config cc
             WHERE cc.key = 'regua_preco_aliquota_venda_oben'), 0.15) INTO v_aliquota;

  -- taxa do custo de capital: REUSA a RPC já provada (db/test-regua-custo-capital-money-path.sh)
  -- em vez de reimplementar o unit gate. Só é consultada quando há prazo a aplicar.
  IF p_prazo_dias IS NOT NULL AND array_length(p_prazo_dias, 1) IS NOT NULL THEN
    v_taxa := public.fin_regua_custo_capital(v_account);
  END IF;

  SELECT piso, prazo_aplicado INTO v_piso, v_prazo_ok
    FROM private.regua_piso_calc(v_cmc, v_aliquota, p_prazo_dias, v_taxa);

  -- ⚠️ CEIL, não ROUND (regressão introduzida pela correção de arredondamento da rodada 1 e pega
  -- na rodada 2). O número exposto vira `precoReferencia` e o botão "Aplicar piso" o joga no
  -- carrinho. Com round(), 13.449023861… vira 13.4490 — que continua ABAIXO do piso íntegro, então
  -- aplicar a sugestão mantém o vermelho e a vendedora fica num laço. Arredondar para CIMA na
  -- mesma escala garante que o valor devolvido, se aplicado, LIMPA o piso. Verificado no PG17.
  -- o round(,4) externo NÃO muda o valor (já está em 4 casas): normaliza a ESCALA, que a
  -- divisão infla para 16+ e vazaria como "13.4491000000000000" no jsonb.
  v_piso_exib := CASE WHEN v_piso IS NOT NULL THEN round(ceil(v_piso * 10000) / 10000, 4) END;

  -- A COMPARAÇÃO acontece AQUI. É o ponto inteiro desta migration: no cliente, ela viraria busca
  -- binária pelo piso. Sem preço ou sem piso → false (não fabrica sinal).
  v_abaixo := (private.regua_num_finito(p_preco_atual) AND p_preco_atual > 0
               AND v_piso IS NOT NULL AND p_preco_atual < v_piso);

  SELECT array_agg(oi.unit_price ORDER BY so.order_date_kpi DESC) INTO v_precos_cli
    FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
   WHERE so.account = v_account AND so.deleted_at IS NULL AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
     AND oi.product_id = p_product AND oi.customer_user_id = p_customer
     AND oi.unit_price > 0 AND so.order_date_kpi >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '180 days';

  WITH base AS (
    SELECT oi.unit_price, dense_rank() OVER (ORDER BY oi.customer_user_id) AS c_ord
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account AND so.deleted_at IS NULL AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
       AND oi.product_id = p_product AND oi.customer_user_id <> p_customer
       AND oi.unit_price > 0 AND oi.quantity BETWEEN v_qty_lo AND v_qty_hi
       AND so.order_date_kpi >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '180 days'
  )
  SELECT jsonb_agg(jsonb_build_object('preco', unit_price, 'c', c_ord)) INTO v_comparaveis FROM base;

  RETURN jsonb_build_object(
    -- SINAL (todo mundo que passa no gate de staff)
    'abaixo_piso',     v_abaixo,
    'piso_disponivel', v_piso IS NOT NULL,
    'cmc_confiavel',   v_cmc IS NOT NULL,
    'prazo_aplicado',  COALESCE(v_prazo_ok, false),
    -- NÚMERO (só cap_custo_ler). piso_gap_pct é invertível para o piso → mesmo gate.
    -- o piso APLICÁVEL (ceil) é o que sai; a decisão acima usou o íntegro. O gap sai do mesmo
    -- valor exposto, senão gap×preço reconstruiria um número que o botão não aplica.
    'piso_mc',         CASE WHEN v_pode_num THEN to_jsonb(v_piso_exib) ELSE 'null'::jsonb END,
    'piso_gap_pct',    CASE WHEN v_pode_num AND v_piso_exib IS NOT NULL
                             AND private.regua_num_finito(p_preco_atual) AND p_preco_atual > 0
                            THEN to_jsonb(round(v_piso_exib / p_preco_atual - 1, 6)) ELSE 'null'::jsonb END,
    -- MERCADO (preço de venda, não custo — aberto de propósito)
    'precos_cliente',  COALESCE(to_jsonb(v_precos_cli), '[]'::jsonb),
    'comparaveis',     COALESCE(v_comparaveis, '[]'::jsonb)
  );
END;
$function$;

-- public.get_regua_preco_customer360
CREATE OR REPLACE FUNCTION public.get_regua_preco_customer360(p_customer uuid, p_omie_codigos bigint[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account        text := 'oben';
  v_codigos        bigint[];
  v_codigo         bigint;
  v_product_id     uuid;
  v_preco_atual    numeric;
  v_preco_atual_at date;
  v_qty_preco      numeric;
  v_pacote         jsonb;
  v_out            jsonb := '[]'::jsonb;
BEGIN
  IF NOT (public.has_role((SELECT auth.uid()), 'employee') OR public.has_role((SELECT auth.uid()), 'master')) THEN
    RAISE EXCEPTION 'forbidden: regua_preco exige staff' USING ERRCODE = '42501';
  END IF;

  SELECT array_agg(DISTINCT x) INTO v_codigos
    FROM unnest(COALESCE(p_omie_codigos, ARRAY[]::bigint[])) x
   WHERE x IS NOT NULL;

  IF v_codigos IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  FOREACH v_codigo IN ARRAY v_codigos LOOP
    v_product_id := NULL; v_preco_atual := NULL; v_preco_atual_at := NULL;
    v_qty_preco := NULL; v_pacote := NULL;

    SELECT oi.product_id INTO v_product_id
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account AND so.deleted_at IS NULL AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
       AND oi.customer_user_id = p_customer AND oi.omie_codigo_produto = v_codigo
       AND oi.product_id IS NOT NULL
     ORDER BY so.order_date_kpi DESC NULLS LAST, so.created_at DESC NULLS LAST, oi.id DESC
     LIMIT 1;

    IF v_product_id IS NULL THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo', v_codigo, 'hide_reason', 'sem_produto'));
      CONTINUE;
    END IF;

    SELECT oi.unit_price, so.order_date_kpi, oi.quantity
      INTO v_preco_atual, v_preco_atual_at, v_qty_preco
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account AND so.deleted_at IS NULL AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
       AND oi.customer_user_id = p_customer AND oi.product_id = v_product_id
       AND oi.unit_price > 0
     ORDER BY so.order_date_kpi DESC NULLS LAST, so.created_at DESC NULLS LAST, oi.id DESC
     LIMIT 1;

    IF v_preco_atual IS NULL THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo', v_codigo, 'product_id', v_product_id, 'hide_reason', 'sem_preco'));
      CONTINUE;
    END IF;

    IF v_qty_preco IS NULL OR v_qty_preco <= 0 THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo',    v_codigo,
        'product_id',     v_product_id,
        'preco_atual',    v_preco_atual,
        'preco_atual_at', v_preco_atual_at,
        'hide_reason',    'sem_quantidade'));
      CONTINUE;
    END IF;

    -- passa o preço que ela já tinha: a decisão do piso vem pronta de dentro.
    v_pacote := public.get_regua_preco(p_customer, v_product_id, v_qty_preco, v_preco_atual, NULL);

    v_out := v_out || jsonb_build_array(
      jsonb_build_object(
        'omie_codigo',    v_codigo,
        'product_id',     v_product_id,
        'preco_atual',    v_preco_atual,
        'preco_atual_at', v_preco_atual_at,
        'qty_ref',        v_qty_preco,
        'qty_ref_source', 'ultima_venda',
        'hide_reason',    NULL
      ) || COALESCE(v_pacote, '{}'::jsonb)
    );
  END LOOP;

  RETURN v_out;
END;
$function$;

-- public.get_whatsapp_proposta_cotacao
CREATE OR REPLACE FUNCTION public.get_whatsapp_proposta_cotacao(p_customer_user_id uuid, p_account text, p_skus bigint[])
 RETURNS TABLE(omie_codigo_produto bigint, product_id uuid, codigo text, descricao text, unidade text, ativo boolean, estoque numeric, preco numeric, fonte_preco text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH praticado AS (
    -- último preço praticado VÁLIDO do próprio cliente NA CONTA consultada, por SKU
    -- (cronologia comercial: item → pedido pai; tie-break estável por id)
    SELECT DISTINCT ON (oi.omie_codigo_produto)
           oi.omie_codigo_produto, oi.unit_price
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE oi.customer_user_id = p_customer_user_id
       AND so.account = p_account
       AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
       AND so.deleted_at IS NULL
       AND oi.omie_codigo_produto = ANY(p_skus)
       AND oi.unit_price > 0
       AND oi.unit_price <> 'NaN'::numeric
       AND oi.unit_price < 'Infinity'::numeric
     ORDER BY oi.omie_codigo_produto,
              COALESCE(oi.created_at, so.created_at) DESC NULLS LAST,
              oi.id DESC
  )
  SELECT p.omie_codigo_produto,
         p.id AS product_id,
         p.codigo,
         p.descricao,
         p.unidade,
         p.ativo,
         p.estoque,
         COALESCE(
           pr.unit_price,
           CASE WHEN p.valor_unitario > 0
                 AND p.valor_unitario <> 'NaN'::numeric
                 AND p.valor_unitario < 'Infinity'::numeric
                THEN p.valor_unitario END
         ) AS preco,
         CASE WHEN pr.unit_price IS NOT NULL THEN 'praticado'
              WHEN p.valor_unitario > 0
               AND p.valor_unitario <> 'NaN'::numeric
               AND p.valor_unitario < 'Infinity'::numeric THEN 'tabela'
         END AS fonte_preco
    FROM public.omie_products p
    LEFT JOIN praticado pr ON pr.omie_codigo_produto = p.omie_codigo_produto
   WHERE p.account = p_account
     AND p.omie_codigo_produto = ANY(p_skus);
$function$;

-- public.get_ultimos_precos_cliente
CREATE OR REPLACE FUNCTION public.get_ultimos_precos_cliente(p_customer uuid)
 RETURNS TABLE(product_id uuid, unit_price numeric, ultimo_praticado_em date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'employee'::public.app_role) OR public.has_role(auth.uid(), 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'forbidden: get_ultimos_precos_cliente exige staff' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT DISTINCT ON (oi.product_id) oi.product_id, oi.unit_price,
    COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS ultimo_praticado_em
  FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
  WHERE oi.customer_user_id = p_customer AND oi.customer_user_id = so.customer_user_id
    AND so.deleted_at IS NULL AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND oi.unit_price > 0 AND oi.product_id IS NOT NULL
    -- anti-futuro contra o hoje de SP: o "hoje" da sessão UTC da prod já é amanhã das 21:00 às 23:59 BRT
    AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
  ORDER BY oi.product_id, COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) DESC,
           so.created_at DESC, oi.created_at DESC, oi.id DESC;
END; $function$;

-- public.medir_abaixo_piso_tier
CREATE OR REPLACE FUNCTION public.medir_abaixo_piso_tier(p_dias integer DEFAULT 90)
 RETURNS TABLE(company text, tier text, itens_abaixo bigint, total_itens bigint, folga_negativa_reais numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- E2/FU4: era `pode_ver_carteira_completa`. Os parênteses ao redor do COALESCE não são
  -- estilo: `scripts/authz-gate-check.ts` só reconhece como BLOQUEIO as formas
  -- `IF NOT <gate>(…)` e `IF NOT ( … <gate>(…) … )`. Escrito como
  -- `IF NOT COALESCE(<gate>(…), false)` o CI classifica como gate DECORATIVO e falha.
  IF NOT (COALESCE(private.cap_custo_ler(auth.uid()), false)) THEN
    RAISE EXCEPTION 'forbidden: medir_abaixo_piso_tier exige capability de custo' USING errcode = '42501';
  END IF;
  RETURN QUERY
  WITH itens AS (
    SELECT so.account AS company, ctp.tier, oi.unit_price, oi.quantity, oi.omie_codigo_produto, op.familia,
      (SELECT ip.cmc FROM inventory_position ip
        WHERE ip.omie_codigo_produto = oi.omie_codigo_produto AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
          AND ip.account = ANY(CASE so.account WHEN 'oben' THEN ARRAY['vendas','oben']
                WHEN 'colacor' THEN ARRAY['colacor_vendas','colacor'] ELSE ARRAY[so.account] END)
        ORDER BY ip.synced_at DESC NULLS LAST LIMIT 1) AS cmc
    FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
    LEFT JOIN public.cliente_tier_preco ctp ON ctp.company = so.account AND ctp.customer_user_id = so.customer_user_id
    LEFT JOIN public.omie_products op ON op.omie_codigo_produto = oi.omie_codigo_produto AND op.account = so.account
    WHERE so.deleted_at IS NULL AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
      AND so.omie_numero_pedido IS NOT NULL AND so.omie_numero_pedido::text <> ''
      AND so.account IN ('oben', 'colacor')
      -- janela de p_dias dias de SP contada do hoje de SP: a da sessão UTC da prod perdia o dia mais antigo das 21:00 às 23:59 BRT
      AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - p_dias
      AND oi.unit_price > 0
  ),
  avaliado AS (
    SELECT i.company, i.tier, i.unit_price, i.quantity, i.cmc, rp.piso_markup FROM itens i
    LEFT JOIN LATERAL public.resolve_markup_policy(i.company, i.omie_codigo_produto, i.familia, i.tier) rp ON true
    WHERE i.cmc IS NOT NULL AND i.cmc > 0
  )
  SELECT a.company, a.tier,
    count(*) FILTER (WHERE a.piso_markup IS NOT NULL AND a.unit_price < a.cmc * (1 + a.piso_markup/100)) AS itens_abaixo,
    count(*) AS total_itens,
    COALESCE(SUM((a.cmc * (1 + a.piso_markup/100) - a.unit_price) * a.quantity)
             FILTER (WHERE a.piso_markup IS NOT NULL AND a.unit_price < a.cmc * (1 + a.piso_markup/100)), 0) AS folga_negativa_reais
  FROM avaliado a GROUP BY a.company, a.tier ORDER BY a.company, a.tier NULLS FIRST;
END; $function$;

-- public.get_defasagem_cliente
CREATE OR REPLACE FUNCTION public.get_defasagem_cliente(p_itens jsonb, p_customer_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- constantes (espelho de DEFASAGEM_CONST do helper)
  c_tol_pp        constant numeric := 3;      -- pontos percentuais
  c_piso_alta     constant numeric := 2;      -- % alta mínima (anti-ruído)
  c_piso_acao_pp  constant numeric := 2;      -- % de p_now
  c_piso_acao_rs  constant numeric := 1;      -- R$ absolutos
  c_ancora_max    constant int     := 18;     -- meses
  c_quarentena    constant numeric := 50;     -- % alta absurda
  c_janela_dias   constant int     := 7;      -- ±dias da data da âncora p/ casar C_last
  c_stale_horas   constant int     := 48;     -- C_now stale se synced_at < now()-48h

  v_pode_num boolean;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_empresa text; v_codigo bigint; v_preco numeric; v_accounts text[];

  v_p_last numeric; v_qtd_ancora numeric; v_data_ancora date;
  v_disc boolean; v_qty_carrinho numeric;
  v_c_last numeric; v_c_now numeric; v_c_now_synced timestamptz;
  v_status text; v_motivo text; v_p_req numeric; v_alta_perc numeric;
  v_markup_ant numeric; v_tem_ancora boolean;
  v_razao numeric; v_alta numeric; v_subiu_preco numeric; v_gap_reais numeric; v_piso_acao numeric;
  v_data_label text;
BEGIN
  -- Gate de staff IDÊNTICO à 2a.
  IF NOT (auth.uid() IS NOT NULL
    AND (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role))) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  IF jsonb_array_length(p_itens) > 200 THEN
    RAISE EXCEPTION 'too many items (max 200)' USING errcode = '22023';
  END IF;
  v_pode_num := private.cap_custo_ler(auth.uid());

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    -- reset por item
    v_p_last := NULL; v_qtd_ancora := NULL; v_data_ancora := NULL; v_disc := NULL;
    v_c_last := NULL; v_c_now := NULL; v_c_now_synced := NULL; v_qty_carrinho := NULL;
    v_status := NULL; v_motivo := NULL; v_p_req := NULL; v_alta_perc := NULL;
    v_markup_ant := NULL; v_tem_ancora := false; v_data_label := NULL;

    v_empresa := lower(v_item->>'empresa');
    v_codigo  := (v_item->>'codigo')::bigint;
    v_preco   := (v_item->>'preco')::numeric;
    v_qty_carrinho := NULLIF(v_item->>'qty','')::numeric;  -- opcional (G5); se ausente, qty_ratio passa

    v_accounts := CASE v_empresa
            WHEN 'oben'       THEN ARRAY['vendas','oben']
            WHEN 'colacor'    THEN ARRAY['colacor_vendas','colacor']
            WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc']
            ELSE ARRAY[v_empresa] END;

    -- ── ÂNCORA: última compra REAL deste cliente p/ este produto (account-aware) ──
    -- Data da âncora: dInc do omie_payload (DD/MM/YYYY) → fallback order_date_kpi.
    -- Pega o pedido mais recente por essa data; média ponderada por quantity é tratada
    -- abaixo (mesmo dia). Aqui resolvemos a DATA e o flag de desconto do pedido vencedor.
    WITH ancora AS (
      SELECT
        oi.unit_price,
        oi.quantity,
        oi.discount AS disc_item,
        so.discount AS disc_pedido,
        COALESCE(
          to_date(NULLIF(so.omie_payload->'infoCadastro'->>'dInc',''),'DD/MM/YYYY'),
          so.order_date_kpi
        ) AS data_real,
        (so.omie_payload->'infoCadastro'->>'dInc') IS NOT NULL
          OR so.order_date_kpi IS NOT NULL AS data_ok
      FROM order_items oi
      JOIN sales_orders so ON so.id = oi.sales_order_id
      WHERE oi.customer_user_id = p_customer_user_id
        AND oi.omie_codigo_produto = v_codigo
        AND so.account = ANY(v_accounts)
        AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')  -- universo canônico (src/lib/farmer/universo-pedidos.ts)
        AND so.omie_pedido_id IS NOT NULL
        AND so.deleted_at IS NULL
    ),
    melhor_data AS (
      -- a data da âncora = a maior data_real entre as linhas válidas (com data_ok)
      SELECT max(data_real) AS data_real
      FROM ancora
      WHERE data_ok AND data_real IS NOT NULL
    ),
    no_dia AS (
      -- todas as linhas naquele dia → média ponderada por quantity do unit_price
      SELECT
        a.*,
        (SELECT data_real FROM melhor_data) AS data_alvo
      FROM ancora a
      WHERE a.data_real = (SELECT data_real FROM melhor_data)
    )
    SELECT
      -- ⚠️ As duas somas do PRECO sao FILTRADAS pelas linhas com preco utilizavel; a
      -- quantidade da ancora (linha de baixo) NAO e — sao medidas diferentes.
      -- Sem o FILTER no DENOMINADOR, uma linha sem preco DILUI a media: duas linhas do
      -- mesmo SKU/dia, quantidade 1 cada, precos 100 e NULL, davam 100/2 = 50. Um preco
      -- que ninguem praticou, que depois passa pelo guard positivo e alimenta p_req,
      -- markup e a classificacao de defasagem. [P1 do challenge Codex]
      -- `> 0` e nao `IS NOT NULL`: preco zero informado tambem nao e preco praticado.
      CASE WHEN sum(quantity) FILTER (WHERE unit_price > 0) > 0
           THEN sum(unit_price * quantity) FILTER (WHERE unit_price > 0)
                / sum(quantity) FILTER (WHERE unit_price > 0)
           ELSE NULL END,
      sum(quantity),
      (SELECT data_real FROM melhor_data),
      bool_or(COALESCE(disc_item,0) > 0 OR COALESCE(disc_pedido,0) > 0),
      (count(*) > 0)
    INTO v_p_last, v_qtd_ancora, v_data_ancora, v_disc, v_tem_ancora
    FROM no_dia;

    -- ── C_now: CMC atual freshest (account-aware), + frescor (G6) ──
    SELECT ip.cmc, ip.synced_at
      INTO v_c_now, v_c_now_synced
    FROM inventory_position ip
    WHERE ip.omie_codigo_produto = v_codigo
      AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
      AND ip.account = ANY(v_accounts)
    ORDER BY ip.synced_at DESC NULLS LAST
    LIMIT 1;

    -- ── C_last: cmc_snapshot na data da âncora, janela ±7 dias, o mais próximo ──
    IF v_data_ancora IS NOT NULL THEN
      SELECT cs.cmc
        INTO v_c_last
      FROM cmc_snapshot cs
      WHERE cs.omie_codigo_produto = v_codigo
        AND cs.account = ANY(v_accounts)
        AND cs.cmc > 0 AND cs.cmc <> 'NaN'::numeric
        AND abs(cs.data_posicao - v_data_ancora) <= c_janela_dias
      ORDER BY abs(cs.data_posicao - v_data_ancora) ASC, cs.synced_at DESC
      LIMIT 1;
    END IF;

    -- ════════ REGRA À PROVA DE CATRACA (1:1 com defasagem.ts) ════════
    -- Ordem dos guards = literal da spec §5.2-5.4.
    IF NOT v_tem_ancora THEN
      v_status := 'sem_historico'; v_motivo := 'sem_historico';
    ELSIF v_disc THEN
      v_status := 'neutro'; v_motivo := 'desconto_nao_provado';
    ELSIF v_data_ancora IS NULL THEN
      v_status := 'sem_data_confiavel'; v_motivo := 'sem_data_confiavel';
    ELSIF v_c_now IS NULL OR v_c_now_synced IS NULL
          OR v_c_now_synced < now() - make_interval(hours => c_stale_horas) THEN
      v_status := 'sem_custo_atual_fresco'; v_motivo := 'sem_custo_atual_fresco';
    ELSIF v_c_last IS NULL THEN
      -- sem snapshot na janela → neutro (não arrisca FP — Codex #1)
      v_status := 'neutro'; v_motivo := 'sem_custo_historico';
    ELSIF v_p_last IS NULL OR v_p_last <= 0 OR v_p_last = 'NaN'::numeric
          OR v_c_last <= 0 OR v_c_last = 'NaN'::numeric
          OR v_c_now  <= 0 OR v_c_now  = 'NaN'::numeric THEN
      v_status := 'neutro'; v_motivo := 'sem_base';
    ELSIF v_qty_carrinho IS NOT NULL AND v_qtd_ancora IS NOT NULL AND v_qtd_ancora > 0
          AND (v_qty_carrinho / v_qtd_ancora >= 10 OR v_qtd_ancora / v_qty_carrinho >= 10) THEN
      -- G5: ordem de grandeza divergente → revisar
      v_status := 'revisar'; v_motivo := 'qty_divergente';
    ELSIF EXTRACT(EPOCH FROM (now() - v_data_ancora::timestamptz)) / (86400 * 30.4375) > c_ancora_max THEN
      v_status := 'neutro'; v_motivo := 'ancora_antiga';
    ELSE
      v_razao := v_c_now / v_c_last;
      IF v_razao - 1 > c_quarentena / 100 THEN
        v_status := 'revisar'; v_motivo := 'quarentena_custo';
      ELSIF v_p_last <= v_c_last THEN
        v_status := 'neutro'; v_motivo := 'prejuizo_ancora';   -- G1
      ELSIF v_c_now <= v_c_last THEN
        v_status := 'sem_alta'; v_motivo := 'custo_nao_subiu';
      ELSE
        v_alta := v_razao - 1;
        IF v_alta < c_piso_alta / 100 THEN
          v_status := 'sem_alta'; v_motivo := 'alta_ruido';
        ELSE
          v_p_req := round(v_p_last * v_razao, 2);
          v_alta_perc := v_alta * 100;
          v_subiu_preco := CASE WHEN v_preco > 0 THEN v_preco / v_p_last - 1 ELSE -1 END;
          IF v_subiu_preco < v_alta - c_tol_pp / 100 THEN
            -- passa por razão → testa piso de ação (em R$ arredondado a centavo)
            v_gap_reais := round(v_p_req, 2) - round(v_preco, 2);
            v_piso_acao := greatest((c_piso_acao_pp / 100) * v_preco, c_piso_acao_rs);
            IF v_gap_reais < v_piso_acao THEN
              v_status := 'em_dia'; v_motivo := 'gap_abaixo_do_piso';
            ELSE
              v_status := 'defasado'; v_motivo := 'custo_subiu_preco_nao_acompanhou';
            END IF;
          ELSE
            v_status := 'em_dia'; v_motivo := 'preco_acompanhou';
          END IF;
        END IF;
      END IF;
    END IF;

    -- markup anterior (só p/ gestor) — só faz sentido com base válida.
    IF v_p_last IS NOT NULL AND v_c_last IS NOT NULL AND v_c_last > 0 AND v_c_last <> 'NaN'::numeric THEN
      v_markup_ant := (v_p_last - v_c_last) / v_c_last * 100;
    END IF;

    -- rótulo da data da âncora = MM/AAAA
    v_data_label := CASE WHEN v_data_ancora IS NOT NULL THEN to_char(v_data_ancora,'MM/YYYY') ELSE NULL END;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'codigo', v_codigo, 'empresa', v_empresa,
      'status_defasagem', v_status,
      'tem_ancora', v_tem_ancora,
      'p_req', to_jsonb(v_p_req),
      'alta_custo_perc', to_jsonb(v_alta_perc),
      'data_ancora', to_jsonb(v_data_label),
      'motivo', v_motivo,
      'calculated_at', now(),
      -- role-gated (absolutos só p/ pode_ver_carteira_completa):
      'p_last',         CASE WHEN v_pode_num THEN to_jsonb(v_p_last)      ELSE 'null'::jsonb END,
      'c_last',         CASE WHEN v_pode_num THEN to_jsonb(v_c_last)      ELSE 'null'::jsonb END,
      'c_now',          CASE WHEN v_pode_num THEN to_jsonb(v_c_now)       ELSE 'null'::jsonb END,
      'markup_anterior',CASE WHEN v_pode_num THEN to_jsonb(v_markup_ant)  ELSE 'null'::jsonb END
    ));
  END LOOP;

  RETURN v_out;
END;
$function$;

-- public.tint_ultimo_preco_cliente
CREATE OR REPLACE FUNCTION public.tint_ultimo_preco_cliente(p_customer_user_id uuid, p_product_id uuid, p_cor_id text, p_exclude_sales_order_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'price', (it.item->>'valor_unitario')::float8,
    'date',  so.created_at,
    'sales_order_id', so.id
  )
  FROM public.sales_orders so
  -- CASE defensivo: linha histórica com items não-array NÃO pode derrubar a
  -- RPC (a ordem de avaliação WHERE×LATERAL não é garantida pelo planner —
  -- um typeof no WHERE não protegeria o jsonb_array_elements).
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(so.items) = 'array' THEN so.items ELSE '[]'::jsonb END
  ) AS it(item)
  WHERE so.customer_user_id = p_customer_user_id
    AND so.account = 'oben'
    -- acordo comercial só conta se virou pedido REAL no Omie…
    AND so.omie_pedido_id IS NOT NULL
    -- …no universo de VENDA (denylist canônica + não apagado: src/lib/farmer/universo-pedidos.ts)…
    AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND so.deleted_at IS NULL
    -- …recente (validade da inferência; fora da janela = renegociar)…
    AND so.created_at >= now() - interval '180 days'
    -- …e NUNCA o pedido que está sendo validado (anti-autovalidação)
    AND (p_exclude_sales_order_id IS NULL OR so.id <> p_exclude_sales_order_id)
    AND it.item->>'product_id' = p_product_id::text
    AND it.item->>'tint_cor_id' = p_cor_id
    AND jsonb_typeof(it.item->'valor_unitario') = 'number'
    AND (it.item->>'valor_unitario')::float8 > 0
  ORDER BY so.created_at DESC
  LIMIT 1
$function$;

DO $pos$
DECLARE r record; v_src text; v_cfg text; v_acl text; v_ret record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.get_regua_preco(uuid,uuid,numeric,numeric,numeric[])', 'b07051bec32e32f6b40b1991a92f07df'),
      ('public.get_regua_preco_customer360(uuid,bigint[])', '53c8cc09fdad207c8930384033a47a00'),
      ('public.get_whatsapp_proposta_cotacao(uuid,text,bigint[])', 'bda0102ab47ca37b0ee126f5028233c8'),
      ('public.get_ultimos_precos_cliente(uuid)', 'd20fc5118db564025fc8e3aba8b67746'),
      ('public.medir_abaixo_piso_tier(integer)', '3f0e6844dbcea3bea8bf6a1aca5e0a30'),
      ('public.get_defasagem_cliente(jsonb,uuid)', 'a03eb600ef0d2a946e550aa55bba415e'),
      ('public.tint_ultimo_preco_cliente(uuid,uuid,text,uuid)', '0fc1c4b303dc6fcf39e2b57294ab130b')
    ) AS x(alvo, este)
  LOOP
    SELECT p.prosrc, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
             || coalesce(array_to_string(p.proconfig, ','), '-'),
           coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
      INTO v_src, v_cfg, v_acl
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.alvo);
    IF v_src IS NULL THEN RAISE EXCEPTION 'POS: % sumiu', r.alvo; END IF;
    -- semântica primeiro (diz O QUE está errado); o md5 depois (só diz QUE está)
    IF position($q$so.status NOT IN ('cancelado','rascunho','pendente','orcamento')$q$ IN v_src) = 0
       AND position($q$so.status not in ('cancelado','rascunho','pendente','orcamento')$q$ IN v_src) = 0 THEN
      RAISE EXCEPTION 'POS: % sem a denylist canônica dos 4 no alias so', r.alvo;
    END IF;
    IF v_src ~* 'so\.deleted_at\s+is\s+null' IS NOT TRUE THEN
      RAISE EXCEPTION 'POS: % sem so.deleted_at IS NULL', r.alvo;
    END IF;
    IF v_src ~* $re$(is distinct from 'cancelado'|coalesce\(so\.status|status in \('faturado')$re$ THEN
      RAISE EXCEPTION 'POS: % ainda carrega a forma antiga do universo', r.alvo;
    END IF;
    IF md5(v_src) IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'POS: % md5(prosrc)=% não é o corpo desta migration (%)', r.alvo, md5(v_src), r.este;
    END IF;
    SELECT * INTO v_ret FROM pg_temp.universo_retrato WHERE alvo = r.alvo;
    IF v_ret.config IS DISTINCT FROM v_cfg OR v_ret.acl IS DISTINCT FROM v_acl THEN
      RAISE EXCEPTION 'POS: % mudou config/ACL — antes [%|%], depois [%|%]', r.alvo, v_ret.config, v_ret.acl, v_cfg, v_acl;
    END IF;
  END LOOP;
  RAISE NOTICE 'POS OK';
END $pos$;
