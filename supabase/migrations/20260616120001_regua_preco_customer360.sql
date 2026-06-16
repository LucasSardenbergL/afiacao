-- Régua de Preço — PR4: RPC fetcher batch para o Customer 360.
-- get_regua_preco_customer360 resolve, por omie_codigo, o product_id que o cliente comprou,
-- deriva preco_atual (ÚLTIMO preço real do cliente, all-time, explícito) + qty_ref (mediana do
-- cliente) e REUSA public.get_regua_preco(p_customer, product_id, qty_ref) para o pacote bruto
-- (cmc, alíquota, piso_mc, precos_cliente, comparaveis). ZERO duplicação de lógica de decisão/
-- features — a get_regua_preco continua sendo a única fonte (herda a alíquota calibrada 0.078, etc.);
-- a DECISÃO segue 100% no helper TS avaliarReguaPreco (provado em vitest). Esta RPC é só FETCHER.
-- Pré-flight prod 2026-06-16: order_items tem omie_codigo_produto(bigint)+product_id(uuid);
-- cobertura 82% (resto -> hide_reason 'sem_produto'); 0 omie ambíguo (->N product_id).

CREATE OR REPLACE FUNCTION public.get_regua_preco_customer360(
  p_customer     uuid,
  p_omie_codigos bigint[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account        text := 'oben';
  v_codigos        bigint[];
  v_codigo         bigint;
  v_product_id     uuid;
  v_preco_atual    numeric;
  v_preco_atual_at date;
  v_qty_ref        numeric;
  v_qty_ref_n      integer;
  v_pacote         jsonb;
  v_out            jsonb := '[]'::jsonb;
BEGIN
  -- gate: somente staff (employee | master) — mesma fronteira da get_regua_preco
  IF NOT (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master')) THEN
    RAISE EXCEPTION 'forbidden: regua_preco exige staff' USING ERRCODE = '42501';
  END IF;

  -- normaliza: descarta NULL e duplicatas (front pode mandar repetido)
  SELECT array_agg(DISTINCT x) INTO v_codigos
    FROM unnest(COALESCE(p_omie_codigos, ARRAY[]::bigint[])) x
   WHERE x IS NOT NULL;

  IF v_codigos IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  FOREACH v_codigo IN ARRAY v_codigos LOOP
    v_product_id := NULL; v_preco_atual := NULL; v_preco_atual_at := NULL;
    v_qty_ref := NULL; v_qty_ref_n := NULL; v_pacote := NULL;

    -- (1) resolve product_id: o que ESTE cliente comprou com aquele omie_codigo, mais recente
    --     (ORDER BY date DESC é desempate defensivo; em prod a ambiguidade é 0).
    SELECT oi.product_id INTO v_product_id
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account
       AND so.deleted_at IS NULL
       AND oi.customer_user_id = p_customer
       AND oi.omie_codigo_produto = v_codigo
       AND oi.product_id IS NOT NULL
     ORDER BY so.order_date_kpi DESC NULLS LAST
     LIMIT 1;

    IF v_product_id IS NULL THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo', v_codigo,
        'hide_reason', 'sem_produto'
      ));
      CONTINUE;
    END IF;

    -- (2) preco_atual + preco_atual_at: ÚLTIMO preço real do cliente neste SKU (all-time, explícito —
    --     não inferido de array, não mediana). É o número exibido como "preço atual" no 360.
    SELECT oi.unit_price, so.order_date_kpi
      INTO v_preco_atual, v_preco_atual_at
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account
       AND so.deleted_at IS NULL
       AND oi.customer_user_id = p_customer
       AND oi.product_id = v_product_id
       AND oi.unit_price > 0
     ORDER BY so.order_date_kpi DESC NULLS LAST
     LIMIT 1;

    IF v_preco_atual IS NULL THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo', v_codigo,
        'product_id',  v_product_id,
        'hide_reason', 'sem_preco'
      ));
      CONTINUE;
    END IF;

    -- (3) qty_ref: mediana das quantidades do cliente neste SKU (all-time); qty_ref_n = nº de pedidos.
    --     Vira o centro da banda de comparáveis (0.5x..2x) dentro da get_regua_preco.
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY oi.quantity), count(*)
      INTO v_qty_ref, v_qty_ref_n
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account
       AND so.deleted_at IS NULL
       AND oi.customer_user_id = p_customer
       AND oi.product_id = v_product_id
       AND oi.quantity > 0;

    -- (4) pacote bruto: REUSA get_regua_preco (única fonte de cmc/alíquota/precos/comparaveis).
    v_pacote := public.get_regua_preco(p_customer, v_product_id, v_qty_ref);

    v_out := v_out || jsonb_build_array(
      jsonb_build_object(
        'omie_codigo',    v_codigo,
        'product_id',     v_product_id,
        'preco_atual',    v_preco_atual,
        'preco_atual_at', v_preco_atual_at,
        'qty_ref',        v_qty_ref,
        'qty_ref_n',      v_qty_ref_n,
        'qty_ref_source', 'cliente',
        'hide_reason',    NULL
      ) || COALESCE(v_pacote, '{}'::jsonb)   -- merge: cmc, cmc_confiavel, aliquota_venda, piso_mc, precos_cliente, comparaveis
    );
  END LOOP;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_regua_preco_customer360(uuid, bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_regua_preco_customer360(uuid, bigint[]) TO authenticated;
