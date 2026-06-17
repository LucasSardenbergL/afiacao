-- Régua de Preço — PR2: log closed-loop + RPC fetcher de features.
-- A RPC get_regua_preco é um FETCHER (busca comparáveis controlados + cmc + alíquota).
-- A DECISÃO (hierarquia/cap/confiança) fica no helper TS avaliarReguaPreco (provado em vitest) —
-- sem lógica de decisão duplicada em plpgsql (zero divergência helper<->SQL).
-- Account de CMC canônico: 'oben' com fallback 'vendas' (pré-flight 2026-06-16: espelhos, CMCs idênticos).
-- Alíquota de venda: company_config['regua_preco_aliquota_venda_oben'] (calibrável pelo founder).

-- ========================= 1) Log closed-loop =========================
CREATE TABLE IF NOT EXISTS public.regua_preco_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  account           text NOT NULL,
  customer_user_id  uuid NOT NULL,
  product_id        uuid NOT NULL,
  salesperson_id    uuid,            -- auth.uid() do vendedor que viu a régua
  sales_order_id    uuid,
  quantity          numeric,
  preco_atual       numeric NOT NULL,
  sinal_exibido     text NOT NULL,   -- piso | auto_ref | benchmark | nenhum
  confianca         text NOT NULL,
  preco_referencia  numeric,
  observed_gap_pct  numeric,         -- oportunidade OBSERVADA (não capada) — correção P0 #1 do Codex
  suggested_gap_pct numeric,         -- sugerida (capada)
  piso_mc           numeric,
  cap_limitou       boolean DEFAULT false,
  cmc_usado         numeric,
  cmc_confianca     text,            -- 'real' | 'proxy'
  aliquota_usada    numeric,
  reason_codes      text[],
  preco_final       numeric,         -- outcome: preço que de fato foi pro pedido
  aplicou           boolean,
  outcome_status    text,            -- aplicado | ignorado | pendente
  outcome_at        timestamptz,
  evidence_version  text NOT NULL DEFAULT 'v1'
);

CREATE INDEX IF NOT EXISTS idx_regua_preco_log_cliente_sku
  ON public.regua_preco_log (customer_user_id, product_id, created_at DESC);

ALTER TABLE public.regua_preco_log ENABLE ROW LEVEL SECURITY;

-- staff (employee/master) tem acesso total; customer NÃO acessa (sem policy p/ ele = negado).
DROP POLICY IF EXISTS regua_preco_log_staff_all ON public.regua_preco_log;
CREATE POLICY regua_preco_log_staff_all ON public.regua_preco_log
  FOR ALL TO authenticated
  USING  (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master'));

-- ========================= 2) Seed da alíquota (calibrável) =========================
INSERT INTO public.company_config (key, value)
VALUES ('regua_preco_aliquota_venda_oben', '0.15')
ON CONFLICT (key) DO NOTHING;

-- ========================= 3) RPC fetcher =========================
CREATE OR REPLACE FUNCTION public.get_regua_preco(
  p_customer uuid,
  p_product  uuid,
  p_qty      numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account      text := 'oben';
  v_cmc          numeric;
  v_aliquota     numeric;
  v_precos_cli   numeric[];
  v_comparaveis  jsonb;
  v_qty_lo       numeric := COALESCE(p_qty, 0) * 0.5;
  v_qty_hi       numeric := COALESCE(p_qty, 0) * 2;
BEGIN
  -- gate: somente staff (employee | master)
  IF NOT (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master')) THEN
    RAISE EXCEPTION 'forbidden: regua_preco exige staff' USING ERRCODE = '42501';
  END IF;

  -- CMC: account 'oben' preferido, fallback 'vendas' (espelhos)
  SELECT ip.cmc INTO v_cmc
    FROM public.inventory_position ip
   WHERE ip.product_id = p_product
     AND ip.account IN ('oben', 'vendas')
     AND ip.cmc IS NOT NULL AND ip.cmc > 0
   ORDER BY (ip.account = 'oben') DESC
   LIMIT 1;

  -- alíquota de venda (config; default 0.15 se ausente)
  SELECT COALESCE(
           (SELECT cc.value::numeric FROM public.company_config cc
             WHERE cc.key = 'regua_preco_aliquota_venda_oben'),
           0.15)
    INTO v_aliquota;

  -- preços que o PRÓPRIO cliente pagou neste SKU (180d)
  SELECT array_agg(oi.unit_price ORDER BY so.order_date_kpi DESC)
    INTO v_precos_cli
    FROM public.order_items oi
    JOIN public.sales_orders so ON so.id = oi.sales_order_id
   WHERE so.account = v_account
     AND so.deleted_at IS NULL
     AND oi.product_id = p_product
     AND oi.customer_user_id = p_customer
     AND oi.unit_price > 0
     AND so.order_date_kpi >= current_date - interval '180 days';

  -- comparáveis da carteira: leave-one-CUSTOMER-out + banda de qty + 180d + cliente ANONIMIZADO
  WITH base AS (
    SELECT oi.unit_price,
           dense_rank() OVER (ORDER BY oi.customer_user_id) AS c_ord
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account
       AND so.deleted_at IS NULL
       AND oi.product_id = p_product
       AND oi.customer_user_id <> p_customer            -- leave-one-customer-out
       AND oi.unit_price > 0
       AND oi.quantity BETWEEN v_qty_lo AND v_qty_hi     -- banda de quantidade 0.5x..2x
       AND so.order_date_kpi >= current_date - interval '180 days'
  )
  SELECT jsonb_agg(jsonb_build_object('preco', unit_price, 'c', c_ord))
    INTO v_comparaveis FROM base;

  RETURN jsonb_build_object(
    'cmc',            v_cmc,
    'cmc_confiavel',  v_cmc IS NOT NULL,
    'aliquota_venda', v_aliquota,
    'piso_mc',        CASE WHEN v_cmc IS NOT NULL AND v_aliquota >= 0 AND v_aliquota < 1
                           THEN round(v_cmc / (1 - v_aliquota), 4) ELSE NULL END,
    'precos_cliente', COALESCE(to_jsonb(v_precos_cli), '[]'::jsonb),
    'comparaveis',    COALESCE(v_comparaveis, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_regua_preco(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_regua_preco(uuid, uuid, numeric) TO authenticated;
