-- Régua de Preço — PR4: RPC fetcher batch para o Customer 360.
-- get_regua_preco_customer360 resolve, por omie_codigo, o product_id que o cliente comprou,
-- deriva preco_atual (ÚLTIMO preço real do cliente, explícito) + a QUANTIDADE dessa venda, e
-- REUSA public.get_regua_preco(p_customer, product_id, qty_da_venda) para o pacote bruto
-- (cmc, alíquota, piso_mc, precos_cliente, comparaveis). A banda de comparáveis é centrada na
-- quantidade da venda que gerou o preco_atual (apples-to-apples; mediana distorceria SKU com
-- preço por escala — achado do Codex). ZERO duplicação de lógica de decisão/features — a
-- get_regua_preco continua a única fonte; a DECISÃO segue 100% no helper TS avaliarReguaPreco.
-- "Último" é determinístico: order_date_kpi DESC, created_at DESC, id DESC (sem empate no mesmo dia).
-- Pré-flight prod 2026-06-16: order_items tem omie_codigo_produto(bigint)+product_id(uuid);
-- cobertura 82% (resto -> 'sem_produto'); 0 omie ambíguo (->N product_id).

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
  v_qty_preco      numeric;   -- quantidade da venda que gerou o preco_atual (centro da banda)
  v_pacote         jsonb;
  v_out            jsonb := '[]'::jsonb;
BEGIN
  -- gate: somente staff (employee | master) — mesma fronteira da get_regua_preco.
  -- Necessário aqui (não redundante): os caminhos hide_reason retornam ANTES de chamar a
  -- get_regua_preco, então sem este gate qualquer authenticated enumeraria via p_customer arbitrário.
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
    v_qty_preco := NULL; v_pacote := NULL;

    -- (1) resolve product_id: o que ESTE cliente comprou com aquele omie_codigo, mais recente
    --     (determinístico; em prod a ambiguidade é 0).
    SELECT oi.product_id INTO v_product_id
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account
       AND so.deleted_at IS NULL
       AND oi.customer_user_id = p_customer
       AND oi.omie_codigo_produto = v_codigo
       AND oi.product_id IS NOT NULL
     ORDER BY so.order_date_kpi DESC NULLS LAST, so.created_at DESC NULLS LAST, oi.id DESC
     LIMIT 1;

    IF v_product_id IS NULL THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo', v_codigo,
        'hide_reason', 'sem_produto'
      ));
      CONTINUE;
    END IF;

    -- (2) preco_atual + preco_atual_at + a QUANTIDADE da venda: ÚLTIMO preço real do cliente neste
    --     SKU (explícito — não inferido de array, não mediana). Determinístico (desempate por created_at/id).
    SELECT oi.unit_price, so.order_date_kpi, oi.quantity
      INTO v_preco_atual, v_preco_atual_at, v_qty_preco
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account
       AND so.deleted_at IS NULL
       AND oi.customer_user_id = p_customer
       AND oi.product_id = v_product_id
       AND oi.unit_price > 0
     ORDER BY so.order_date_kpi DESC NULLS LAST, so.created_at DESC NULLS LAST, oi.id DESC
     LIMIT 1;

    IF v_preco_atual IS NULL THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo', v_codigo,
        'product_id',  v_product_id,
        'hide_reason', 'sem_preco'
      ));
      CONTINUE;
    END IF;

    -- (3) sem quantidade confiável nessa venda → NÃO fabricar banda 0..0 (ausente ≠ zero).
    IF v_qty_preco IS NULL OR v_qty_preco <= 0 THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo',    v_codigo,
        'product_id',     v_product_id,
        'preco_atual',    v_preco_atual,
        'preco_atual_at', v_preco_atual_at,
        'hide_reason',    'sem_quantidade'
      ));
      CONTINUE;
    END IF;

    -- (4) pacote bruto: REUSA get_regua_preco com a QUANTIDADE da venda do preco_atual
    --     (banda de comparáveis apples-to-apples). get_regua_preco = única fonte de cmc/preços/comparáveis.
    v_pacote := public.get_regua_preco(p_customer, v_product_id, v_qty_preco);

    v_out := v_out || jsonb_build_array(
      jsonb_build_object(
        'omie_codigo',    v_codigo,
        'product_id',     v_product_id,
        'preco_atual',    v_preco_atual,
        'preco_atual_at', v_preco_atual_at,
        'qty_ref',        v_qty_preco,
        'qty_ref_source', 'ultima_venda',
        'hide_reason',    NULL
      ) || COALESCE(v_pacote, '{}'::jsonb)   -- merge: cmc, cmc_confiavel, aliquota_venda, piso_mc, precos_cliente, comparaveis
    );
  END LOOP;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_regua_preco_customer360(uuid, bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_regua_preco_customer360(uuid, bigint[]) TO authenticated;
