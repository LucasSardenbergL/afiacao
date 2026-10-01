-- db/fixtures/universo-pedidos-predecessoras-prod-20261001.sql
-- ============================================================
-- Os PREDECESSORES das 3 migrations do universo de pedidos (20261001014000/14100/14200), VERBATIM da
-- prod: pg_get_functiondef / pg_get_viewdef(oid, true) via psql-ro em 2026-10-01 ~01:05 UTC, já com
-- 20260929001651 (fuso SP das 7 funções) e 20260930230623 (fuso SP das 18 views) aplicadas.
-- Carregado SOBRE o schema-snapshot pela prova db/test-universo-pedidos-classe.sh: o snapshot é um
-- retrato datado (e perde barras invertidas de literais de regex); a prova precisa do corpo que a PRE
-- vai encontrar na prod, e o asserta pelo md5 anotado em cada bloco.
-- NÃO é migration e não se aplica em lugar nenhum: é dado de teste.
-- ============================================================

-- dependência da melhoria que o snapshot não tem (nasceu em 20260929000234) · md5(prosrc) prod = c8cff40d683ca035791f205d0e83d291
CREATE OR REPLACE FUNCTION private.padrao_like_contem(p_termo text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN btrim(translate(p_termo, '%_', ''), E' \t\r\n') = '' THEN NULL
    ELSE '%' || replace(replace(replace(p_termo, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END
$function$;

-- public.get_regua_preco(uuid,uuid,numeric,numeric,numeric[]) · md5(prosrc) prod = 846b8d591627674ff59b904b53222ff1
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
   WHERE so.account = v_account AND so.deleted_at IS NULL
     AND oi.product_id = p_product AND oi.customer_user_id = p_customer
     AND oi.unit_price > 0 AND so.order_date_kpi >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '180 days';

  WITH base AS (
    SELECT oi.unit_price, dense_rank() OVER (ORDER BY oi.customer_user_id) AS c_ord
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account AND so.deleted_at IS NULL
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

-- public.get_regua_preco_customer360(uuid,bigint[]) · md5(prosrc) prod = 92362d82b03f36e594664e16a334297c
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
     WHERE so.account = v_account AND so.deleted_at IS NULL
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
     WHERE so.account = v_account AND so.deleted_at IS NULL
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

-- public.get_whatsapp_proposta_cotacao(uuid,text,bigint[]) · md5(prosrc) prod = d73ff1824d15ec00b9e0c85091b9e3e7
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

-- public.get_ultimos_precos_cliente(uuid) · md5(prosrc) prod = 77a6962c6f62b1d82d1d31b43b38c5fc
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
    AND so.deleted_at IS NULL AND COALESCE(so.status, '') NOT IN ('cancelado', 'orcamento')
    AND oi.unit_price > 0 AND oi.product_id IS NOT NULL
    -- anti-futuro contra o hoje de SP: o "hoje" da sessão UTC da prod já é amanhã das 21:00 às 23:59 BRT
    AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
  ORDER BY oi.product_id, COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) DESC,
           so.created_at DESC, oi.created_at DESC, oi.id DESC;
END; $function$;

-- public.medir_abaixo_piso_tier(integer) · md5(prosrc) prod = 9fc343369c69aeeb510f67ec22037a12
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
    WHERE so.deleted_at IS NULL AND COALESCE(so.status, '') NOT IN ('cancelado', 'orcamento')
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

-- public.get_defasagem_cliente(jsonb,uuid) · md5(prosrc) prod = 4ad3e130bdf9fda5546ced1450e7b6af
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
        AND so.status IN ('faturado','importado','separacao','enviado')  -- allowlist POSITIVA
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

-- public.tint_ultimo_preco_cliente(uuid,uuid,text,uuid) · md5(prosrc) prod = 712b5761381bb0118c968e9ca56f282d
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
    -- …não-cancelado…
    AND so.status IS DISTINCT FROM 'cancelado'
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

-- public.melhoria_clientes_por_produto(text) · md5(prosrc) prod = fb00b17ac45b38e31a08fe4531c51618
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

-- public.classificar_clientes_fornecedores() · md5(prosrc) prod = 7168163f53b1f515ec0e77ee87018b2d
CREATE OR REPLACE FUNCTION public.classificar_clientes_fornecedores()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_classificados int;
  v_excluidos     int;
BEGIN
  UPDATE public.cliente_classificacao cc SET
    is_fornecedor = EXISTS (
      SELECT 1 FROM unnest(cc.tags_omie) t
      WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora'])
    ),
    tem_venda_real = EXISTS (
      SELECT 1 FROM public.sales_orders so
      WHERE so.customer_user_id = cc.user_id
        AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    ),
    excluir_da_carteira = (
      EXISTS (
        SELECT 1 FROM unnest(cc.tags_omie) t
        WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora'])
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.sales_orders so
        WHERE so.customer_user_id = cc.user_id
          AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
      )
      AND NOT EXISTS (SELECT 1 FROM public.fornecedor_excecao e WHERE e.user_id = cc.user_id)
    ),
    updated_at = now();
  GET DIAGNOSTICS v_classificados = ROW_COUNT;
  SELECT count(*) INTO v_excluidos FROM public.cliente_classificacao WHERE excluir_da_carteira;
  RETURN jsonb_build_object('classificados', v_classificados, 'excluidos', v_excluidos);
END $function$;

-- public.v_caca_compradores · md5(pg_get_viewdef(oid,true)) prod = 41cce289721d3631b1bd518e55dc048f
CREATE OR REPLACE VIEW public.v_caca_compradores WITH (security_invoker = on) AS
 WITH cli AS (
         SELECT p.user_id,
            p.name,
            p.phone,
            p.cnae,
                CASE
                    WHEN length(regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text)) = ANY (ARRAY[11, 14]) THEN regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text)
                    WHEN length(regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)) = ANY (ARRAY[11, 14]) THEN regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)
                    ELSE NULL::text
                END AS documento
           FROM profiles p
          WHERE COALESCE(p.is_employee, false) = false
        ), cli_valid AS (
         SELECT DISTINCT ON (cli.user_id) cli.user_id,
            cli.documento,
            cli.name,
            cli.phone,
            cli.cnae
           FROM cli
          WHERE cli.documento IS NOT NULL
          ORDER BY cli.user_id, cli.documento
        ), cli_doc AS (
         SELECT DISTINCT ON (cli_valid.documento) cli_valid.documento,
            cli_valid.user_id,
            cli_valid.name,
            cli_valid.phone,
            cli_valid.cnae
           FROM cli_valid
          ORDER BY cli_valid.documento, cli_valid.user_id
        ), so_ok AS (
         SELECT so.id,
            so.account,
            so.total,
            COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo'::text)::date) AS dt,
            cv.documento
           FROM sales_orders so
             JOIN cli_valid cv ON cv.user_id = so.customer_user_id
          WHERE so.deleted_at IS NULL AND (so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text])) AND (so.account = ANY (ARRAY['oben'::text, 'colacor'::text]))
        ), compras AS (
         SELECT so_ok.documento,
            so_ok.account,
            count(*) AS n_pedidos,
            sum(so_ok.total) AS volume,
            max(so_ok.dt) AS ultima
           FROM so_ok
          GROUP BY so_ok.documento, so_ok.account
        ), oi_dedup AS (
         SELECT DISTINCT ON (oi.sales_order_id, oi.omie_codigo_produto) oi.sales_order_id,
            oi.product_id,
            oi.quantity,
            oi.unit_price
           FROM order_items oi
          ORDER BY oi.sales_order_id, oi.omie_codigo_produto, oi.id
        ), itens AS (
         SELECT s.documento,
            s.account,
            d.quantity,
            d.unit_price,
            op.familia,
            COALESCE(
                CASE
                    WHEN pc.custo_producao_status = 'ok'::text THEN pc.custo_producao
                    ELSE NULL::numeric
                END, NULLIF(pc.cmc, 0::numeric)) AS custo_efetivo
           FROM so_ok s
             JOIN oi_dedup d ON d.sales_order_id = s.id
             JOIN omie_products op ON op.id = d.product_id AND op.account = s.account
             LEFT JOIN product_costs pc ON pc.product_id = op.id
        ), fam AS (
         SELECT itens.documento,
            itens.account,
            array_agg(DISTINCT itens.familia) FILTER (WHERE itens.familia IS NOT NULL AND itens.familia <> ''::text) AS familias
           FROM itens
          GROUP BY itens.documento, itens.account
        ), luc AS (
         SELECT itens.documento,
            itens.account,
            sum(itens.quantity * itens.unit_price - itens.quantity * itens.custo_efetivo) FILTER (WHERE itens.custo_efetivo > 0::numeric) AS lucro_com_custo,
            sum(itens.quantity * itens.unit_price) AS receita,
            sum(itens.quantity * itens.unit_price) FILTER (WHERE itens.custo_efetivo > 0::numeric) AS receita_com_custo
           FROM itens
          GROUP BY itens.documento, itens.account
        ), cid AS (
         SELECT DISTINCT ON (addresses.user_id) addresses.user_id,
            (addresses.city || '-'::text) || addresses.state AS cidade_uf
           FROM addresses
          WHERE COALESCE(addresses.city, ''::text) <> ''::text AND COALESCE(addresses.state, ''::text) <> ''::text
          ORDER BY addresses.user_id, addresses.is_default DESC NULLS LAST, addresses.created_at DESC NULLS LAST
        )
 SELECT c.documento,
    c.account AS empresa,
    cid.cidade_uf,
    cd.cnae AS ramo,
        CASE
            WHEN c.n_pedidos > 0 THEN round(c.volume / c.n_pedidos::numeric, 2)
            ELSE NULL::numeric
        END AS ticket_faixa,
    COALESCE(f.familias, ARRAY[]::text[]) AS familias,
    c.volume,
    c.n_pedidos,
    (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - c.ultima AS recencia_dias,
        CASE
            WHEN l.lucro_com_custo IS NOT NULL THEN round(l.lucro_com_custo, 2)
            ELSE NULL::numeric
        END AS lucro_proxy,
        CASE
            WHEN COALESCE(l.receita, 0::numeric) > 0::numeric THEN round(COALESCE(l.receita_com_custo, 0::numeric) / l.receita, 2)
            ELSE 0::numeric
        END AS lucro_cobertura
   FROM compras c
     JOIN cli_doc cd ON cd.documento = c.documento
     LEFT JOIN fam f ON f.documento = c.documento AND f.account = c.account
     LEFT JOIN luc l ON l.documento = c.documento AND l.account = c.account
     LEFT JOIN cid ON cid.user_id = cd.user_id;

-- public.v_caca_candidatos · md5(pg_get_viewdef(oid,true)) prod = 24af34211e33745ac90b36c559561dbe
CREATE OR REPLACE VIEW public.v_caca_candidatos WITH (security_invoker = on) AS
 WITH cli AS (
         SELECT p.user_id,
            p.name,
            p.phone,
            p.cnae,
                CASE
                    WHEN length(regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text)) = ANY (ARRAY[11, 14]) THEN regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text)
                    WHEN length(regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)) = ANY (ARRAY[11, 14]) THEN regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)
                    ELSE NULL::text
                END AS documento
           FROM profiles p
          WHERE COALESCE(p.is_employee, false) = false
        ), cli_valid AS (
         SELECT DISTINCT ON (cli.user_id) cli.user_id,
            cli.documento,
            cli.name,
            cli.phone,
            cli.cnae
           FROM cli
          WHERE cli.documento IS NOT NULL
          ORDER BY cli.user_id, cli.documento
        ), cli_doc AS (
         SELECT DISTINCT ON (cli_valid.documento) cli_valid.documento,
            cli_valid.user_id,
            cli_valid.name,
            cli_valid.phone,
            cli_valid.cnae
           FROM cli_valid
          ORDER BY cli_valid.documento, cli_valid.user_id
        ), so_ok AS (
         SELECT so.id,
            so.account,
            so.total,
            COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo'::text)::date) AS dt,
            cv.documento
           FROM sales_orders so
             JOIN cli_valid cv ON cv.user_id = so.customer_user_id
          WHERE so.deleted_at IS NULL AND (so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text])) AND (so.account = ANY (ARRAY['oben'::text, 'colacor'::text]))
        ), ativ AS (
         SELECT so_ok.documento,
            so_ok.account,
            max(so_ok.dt) >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text) - '6 mons'::interval)::date AS ativo_6m
           FROM so_ok
          GROUP BY so_ok.documento, so_ok.account
        ), grupo AS (
         SELECT so_ok.documento,
            max(so_ok.dt) AS ultima_grupo,
            sum(so_ok.total) AS volume_grupo,
            count(*) AS pedidos_grupo
           FROM so_ok
          GROUP BY so_ok.documento
        ), oi_dedup AS (
         SELECT DISTINCT ON (oi.sales_order_id, oi.omie_codigo_produto) oi.sales_order_id,
            oi.product_id
           FROM order_items oi
          ORDER BY oi.sales_order_id, oi.omie_codigo_produto, oi.id
        ), fam_grupo AS (
         SELECT s.documento,
            array_agg(DISTINCT op.familia) FILTER (WHERE op.familia IS NOT NULL AND op.familia <> ''::text) AS familias
           FROM so_ok s
             JOIN oi_dedup d ON d.sales_order_id = s.id
             JOIN omie_products op ON op.id = d.product_id AND op.account = s.account
          GROUP BY s.documento
        ), cid AS (
         SELECT DISTINCT ON (addresses.user_id) addresses.user_id,
            (addresses.city || '-'::text) || addresses.state AS cidade_uf
           FROM addresses
          WHERE COALESCE(addresses.city, ''::text) <> ''::text AND COALESCE(addresses.state, ''::text) <> ''::text
          ORDER BY addresses.user_id, addresses.is_default DESC NULLS LAST, addresses.created_at DESC NULLS LAST
        ), optout_doc AS (
         SELECT DISTINCT cv.documento
           FROM whatsapp_conversations wc
             JOIN cli_valid cv ON cv.user_id = wc.customer_user_id
          WHERE wc.opt_in_status = 'opt_out'::text
        UNION
         SELECT DISTINCT cv.documento
           FROM whatsapp_conversations wc
             JOIN cli_valid cv ON "right"(regexp_replace(COALESCE(cv.phone, ''::text), '\D'::text, ''::text, 'g'::text), 11) = "right"(regexp_replace(COALESCE(wc.phone_e164, wc.phone_key, ''::text), '\D'::text, ''::text, 'g'::text), 11)
          WHERE wc.opt_in_status = 'opt_out'::text AND length(regexp_replace(COALESCE(cv.phone, ''::text), '\D'::text, ''::text, 'g'::text)) >= 10
        ), alvos AS (
         SELECT unnest(ARRAY['oben'::text, 'colacor'::text]) AS empresa_alvo
        ), cand AS (
         SELECT cd.documento,
            a.empresa_alvo,
            cd.user_id,
            cd.name,
            cd.phone,
            cd.cnae
           FROM cli_doc cd
             CROSS JOIN alvos a
          WHERE NOT (EXISTS ( SELECT 1
                   FROM ativ av
                  WHERE av.documento = cd.documento AND av.account = a.empresa_alvo AND av.ativo_6m)) AND NOT (EXISTS ( SELECT 1
                   FROM optout_doc oo
                  WHERE oo.documento = cd.documento))
        )
 SELECT cand.documento,
    cand.empresa_alvo,
    cid.cidade_uf,
    cand.cnae AS ramo,
        CASE
            WHEN g.pedidos_grupo > 0 THEN round(g.volume_grupo / g.pedidos_grupo::numeric, 2)
            ELSE NULL::numeric
        END AS ticket_faixa,
    COALESCE(fg.familias, ARRAY[]::text[]) AS familias,
    (EXISTS ( SELECT 1
           FROM ativ av2
          WHERE av2.documento = cand.documento AND av2.account <> cand.empresa_alvo AND av2.ativo_6m)) AS compra_em_outra_empresa,
        CASE
            WHEN g.ultima_grupo IS NOT NULL THEN (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - g.ultima_grupo
            ELSE NULL::integer
        END AS ultima_compra_grupo_dias,
    cand.name AS nome,
    cand.phone AS telefone,
    cand.user_id AS cliente_user_id
   FROM cand
     LEFT JOIN grupo g ON g.documento = cand.documento
     LEFT JOIN fam_grupo fg ON fg.documento = cand.documento
     LEFT JOIN cid ON cid.user_id = cand.user_id;

-- public.v_grupo_comercial · md5(pg_get_viewdef(oid,true)) prod = 73de52bd7737a62d2828589f97661e9a
CREATE OR REPLACE VIEW public.v_grupo_comercial WITH (security_invoker = true) AS
 WITH ped AS (
         SELECT regexp_replace(COALESCE(p.cnpj, p.document, ''::text), '\D'::text, ''::text, 'g'::text) AS doc,
            (so.created_at AT TIME ZONE 'America/Sao_Paulo'::text)::date AS data,
            COALESCE(so.total, ( SELECT sum(((it.value ->> 'quantity'::text)::numeric) * ((it.value ->> 'unit_price'::text)::numeric)) AS sum
                   FROM jsonb_array_elements(so.items) it(value))) AS valor
           FROM sales_orders so
             JOIN profiles p ON p.user_id = so.customer_user_id
          WHERE (so.status = ANY (ARRAY['faturado'::text, 'importado'::text, 'separacao'::text, 'enviado'::text])) AND so.deleted_at IS NULL
        )
 SELECT m.grupo_id,
    count(DISTINCT ped.doc) FILTER (WHERE ped.doc IS NOT NULL) AS documentos_com_compra,
    count(ped.data) AS qtd_pedidos,
    max(ped.data) AS ultima_compra,
    (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - max(ped.data) AS dias_desde_ultima,
    COALESCE(sum(ped.valor), 0::numeric) AS faturamento_total,
    COALESCE(sum(ped.valor) FILTER (WHERE ped.data > ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 90)), 0::numeric) AS fat_90d,
    COALESCE(sum(ped.valor) FILTER (WHERE ped.data <= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 90) AND ped.data > ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 180)), 0::numeric) AS fat_90d_anterior,
    round(COALESCE(sum(ped.valor) FILTER (WHERE ped.data > ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 180)), 0::numeric) / 6.0, 2) AS media_mensal_6m
   FROM cliente_grupo_membros m
     LEFT JOIN ped ON ped.doc = m.documento
  GROUP BY m.grupo_id;

-- private.customer_metrics_mv · md5(pg_get_viewdef(oid,true)) prod = f47c2fd0fca117f97dc197bbae30670b
-- public.customer_metrics_mv (view-gate) · md5 prod = d1967849771139100c7ef200e0accfe9
DROP VIEW IF EXISTS public.customer_metrics_mv;
DROP MATERIALIZED VIEW IF EXISTS private.customer_metrics_mv;
CREATE MATERIALIZED VIEW private.customer_metrics_mv AS
 WITH base AS (
         SELECT so.customer_user_id,
            so.total,
            COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo'::text)::date) AS d
           FROM sales_orders so
          WHERE so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text])
        ), last_order AS (
         SELECT base.customer_user_id,
            (max(base.d)::timestamp without time zone AT TIME ZONE 'America/Sao_Paulo'::text) AS ultima_compra_data,
            GREATEST(0, (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - max(base.d)) AS dias_desde_ultima_compra
           FROM base
          GROUP BY base.customer_user_id
        ), orders_90d AS (
         SELECT base.customer_user_id,
            count(*) AS pedidos_90d,
            COALESCE(sum(base.total), 0::numeric) AS faturamento_90d,
                CASE
                    WHEN count(*) > 0 THEN COALESCE(sum(base.total), 0::numeric) / count(*)::numeric
                    ELSE 0::numeric
                END AS ticket_medio_90d
           FROM base
          WHERE base.d >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 90) AND base.d <= (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date
          GROUP BY base.customer_user_id
        ), orders_prev_90d AS (
         SELECT base.customer_user_id,
            COALESCE(sum(base.total), 0::numeric) AS faturamento_prev_90d
           FROM base
          WHERE base.d >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 180) AND base.d < ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 90)
          GROUP BY base.customer_user_id
        ), cadence AS (
         SELECT base.customer_user_id,
                CASE
                    WHEN count(*) >= 3 THEN (max(base.d) - min(base.d))::numeric / NULLIF(count(*) - 1, 0)::numeric
                    ELSE NULL::numeric
                END AS intervalo_medio_dias
           FROM base
          GROUP BY base.customer_user_id
        )
 SELECT p.user_id AS customer_user_id,
    p.name AS razao_social,
    p.document,
    lo.ultima_compra_data,
    COALESCE(lo.dias_desde_ultima_compra, 9999) AS dias_desde_ultima_compra,
    COALESCE(o90.pedidos_90d, 0::bigint) AS pedidos_90d,
    COALESCE(o90.faturamento_90d, 0::numeric) AS faturamento_90d,
    COALESCE(o90.ticket_medio_90d, 0::numeric) AS ticket_medio_90d,
    COALESCE(op.faturamento_prev_90d, 0::numeric) AS faturamento_prev_90d,
    c.intervalo_medio_dias,
        CASE
            WHEN c.intervalo_medio_dias IS NOT NULL AND c.intervalo_medio_dias > 0::numeric THEN COALESCE(lo.dias_desde_ultima_compra, 9999)::numeric / c.intervalo_medio_dias
            ELSE NULL::numeric
        END AS atraso_relativo,
        CASE
            WHEN c.intervalo_medio_dias IS NULL THEN true
            ELSE false
        END AS is_cold_start,
    now() AS calculated_at
   FROM profiles p
     LEFT JOIN last_order lo ON lo.customer_user_id = p.user_id
     LEFT JOIN orders_90d o90 ON o90.customer_user_id = p.user_id
     LEFT JOIN orders_prev_90d op ON op.customer_user_id = p.user_id
     LEFT JOIN cadence c ON c.customer_user_id = p.user_id
  WHERE p.is_employee = false OR p.is_employee IS NULL
WITH NO DATA;
CREATE UNIQUE INDEX idx_customer_metrics_mv_uid ON private.customer_metrics_mv USING btree (customer_user_id);
CREATE VIEW public.customer_metrics_mv WITH (security_invoker = off, security_barrier = true) AS
 SELECT customer_user_id,
    razao_social,
    document,
    ultima_compra_data,
    dias_desde_ultima_compra,
    pedidos_90d,
    faturamento_90d,
    ticket_medio_90d,
    faturamento_prev_90d,
    intervalo_medio_dias,
    atraso_relativo,
    is_cold_start,
    calculated_at
   FROM private.customer_metrics_mv
  WHERE (( SELECT auth.role() AS role)) = 'service_role'::text OR COALESCE(( SELECT has_role(( SELECT auth.uid() AS uid), 'master'::app_role) AS has_role), false) OR COALESCE(( SELECT has_role(( SELECT auth.uid() AS uid), 'employee'::app_role) AS has_role), false);

-- ACL de PROD dos 14 alvos (psql-ro, 2026-10-01). O snapshot vem SEM privilégios: sem isto a cópia de ACL
-- da MV e o retrato da PRE/POS seriam exercidos sobre NULL. Reproduzido por GRANT a partir do aclitem[] de prod.
DO $acl$
DECLARE r record; a record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('F', 'classificar_clientes_fornecedores()', '{postgres=X/postgres,service_role=X/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=X/postgres}'),
      ('F', 'get_defasagem_cliente(jsonb,uuid)', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=X/postgres}'),
      ('F', 'get_regua_preco_customer360(uuid,bigint[])', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=X/postgres}'),
      ('F', 'get_regua_preco(uuid,uuid,numeric,numeric,numeric[])', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=X/postgres}'),
      ('F', 'get_ultimos_precos_cliente(uuid)', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=X/postgres}'),
      ('F', 'get_whatsapp_proposta_cotacao(uuid,text,bigint[])', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=X/postgres}'),
      ('F', 'medir_abaixo_piso_tier(integer)', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=X/postgres}'),
      ('F', 'melhoria_clientes_por_produto(text)', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=X/postgres}'),
      ('F', 'tint_ultimo_preco_cliente(uuid,uuid,text,uuid)', '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=X/postgres}'),
      ('R', 'customer_metrics_mv', '{postgres=arwdDxtm/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=ar/postgres,sandbox_exec=ar/postgres,authenticated=r/postgres,service_role=r/postgres,claude_ro=r/postgres}'),
      ('R', 'private.customer_metrics_mv', '{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=ar/postgres,sandbox_exec=ar/postgres,claude_ro=r/postgres}'),
      ('R', 'v_caca_candidatos', '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=ar/postgres,sandbox_exec=ar/postgres,claude_ro=r/postgres}'),
      ('R', 'v_caca_compradores', '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=ar/postgres,sandbox_exec=ar/postgres,claude_ro=r/postgres}'),
      ('R', 'v_grupo_comercial', '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=ar/postgres,sandbox_exec=ar/postgres,claude_ro=r/postgres}')
    ) AS x(tipo, alvo, acl)
  LOOP
    IF r.tipo = 'F' THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.alvo); END IF;
    FOR a IN SELECT * FROM aclexplode(r.acl::aclitem[]) WHERE grantee <> (SELECT oid FROM pg_roles WHERE rolname = 'postgres') LOOP
      EXECUTE format('GRANT %s ON %s %s TO %I', a.privilege_type, CASE r.tipo WHEN 'F' THEN 'FUNCTION' ELSE 'TABLE' END, r.alvo, pg_get_userbyid(a.grantee));
    END LOOP;
  END LOOP;
END $acl$;
