-- 20260708234100_tint_gate_custo_staff.sql
-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  P1 SEGURANÇA — get_tint_price / get_tint_prices (RPC SECURITY DEFINER)         ║
-- ║  vazam o CUSTO comercial (custoBase + custoCorantes = omie_products.            ║
-- ║  valor_unitario da base e dos corantes) a QUALQUER caller `authenticated` —     ║
-- ║  e um CUSTOMER autenticado COMPARTILHA o role PostgREST `authenticated` com o   ║
-- ║  staff. Como as funções são SECURITY DEFINER (rodam como owner, BYPASSAM a      ║
-- ║  RLS), o customer chama POST /rest/v1/rpc/get_tint_price(s) com a anon-key       ║
-- ║  pública + seu JWT e recebe custoBase/custoCorantes de QUALQUER fórmula.         ║
-- ║  Mesma CLASSE do P0 das 5 views (#1246, fechar_views_invoker_off_p0): dado      ║
-- ║  comercial (custo/margem) projetado a não-staff via objeto SECDEF.              ║
-- ║                                                                                ║
-- ║  ⚠️ O brief inicial dizia "só o batch vaza; o singular já protege". FALSO       ║
-- ║  (verificado na PROD via psql-ro 2026-07-08): o singular `get_tint_price` só     ║
-- ║  gateia `itensCorantes` (a receita item-a-item) — custoBase/custoCorantes saem   ║
-- ║  ABERTOS nas DUAS funções. O customer chama AMBAS (singular a cada cor           ║
-- ║  selecionada via useTintPricing; batch nas embalagens alternativas via          ║
-- ║  useTintPrices). Por isso o fix cobre as DUAS.                                   ║
-- ║                                                                                ║
-- ║  FIX (gate de PROJEÇÃO, NÃO revogar authenticated): custoBase e custoCorantes    ║
-- ║  → CASE WHEN <is_staff> THEN <valor> ELSE NULL END. O CÁLCULO interno de         ║
-- ║  precoFinal continua usando os valores REAIS (esconde só na SAÍDA). Preservados  ║
-- ║  VISÍVEIS ao customer: precoFinal, baseDisponivel, corantesCompletos — é o       ║
-- ║  PREÇO DE VENDA do balcão (desconto é aplicado sobre precoFinal; comparado ao    ║
-- ║  CSV de venda preco_final_sayersystem). Revogar `authenticated` quebraria o      ║
-- ║  balcão do customer que legitimamente vê o preço da tinta.                       ║
-- ║                                                                                ║
-- ║  Invariante (auth): não-staff (customer/anon) → custoBase IS NULL E             ║
-- ║  custoCorantes IS NULL, MAS precoFinal presente. staff (employee/master) →       ║
-- ║  custoBase/custoCorantes com o valor real. Prova + FALSIFICAÇÃO no PG17:          ║
-- ║  db/test-tint-gate-custo-staff.sh (as duas funções, staff/customer/anon).       ║
-- ║                                                                                ║
-- ║  Impacto no front: ZERO regressão de UX. custoBase não tem consumidor no front   ║
-- ║  (só testes/tipos); custoCorantes NÃO é renderizado — só viaja ao onConfirm →    ║
-- ║  tint_custo_corantes no carrinho — EFÊMERO (o submit grava cor/fórmula/preço,    ║
-- ║  não o custo; submitOrder.ts). precoFinal/baseDisponivel/corantesCompletos       ║
-- ║  seguem intactos. Paridade com o oráculo TS compute-price.ts é do CÁLCULO        ║
-- ║  (base+corantes) — o gate é AUTORIZAÇÃO server-only, não muda o cálculo, então   ║
-- ║  o oráculo NÃO precisa mudar.                                                     ║
-- ║                                                                                ║
-- ║  ⚠️ MIGRATION MANUAL — Lovable não auto-aplica nome custom. SQL Editor → Run.    ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- Guard: as deps do gate têm de existir (senão a função é criada late-bound e quebra
-- em RUNTIME — plpgsql/sql não valida o corpo no CREATE). Idempotente.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='has_role' AND pronamespace='public'::regnamespace) THEN
    RAISE EXCEPTION 'dep ausente: public.has_role — o gate de staff depende dela (prod divergiu?)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='uid' AND pronamespace='auth'::regnamespace) THEN
    RAISE EXCEPTION 'dep ausente: auth.uid — o gate de staff depende dela (prod divergiu?)';
  END IF;
END $$;

-- ── SINGULAR (plpgsql) — gate de custoBase/custoCorantes na projeção ──
-- Copiado VERBATIM da def de PROD (== repo 20260616120000, sem drift); mudam SÓ as
-- duas linhas de custo na projeção final (CASE WHEN v_is_staff). O restante — cálculo,
-- gate de `ativo`, fail-closed, gate de itensCorantes — preservado idêntico.
CREATE OR REPLACE FUNCTION public.get_tint_price(p_formula_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_staff boolean;
  v_base_preco numeric;
  v_base_ativo boolean;
  v_base_disponivel boolean;
  v_custo_base numeric;
  v_custo_corantes numeric;
  v_corantes_completos boolean;
  v_preco_final numeric;
  v_itens jsonb;
BEGIN
  v_is_staff := auth.uid() IS NOT NULL
    AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));

  -- Base: preço E status do produto Omie vinculado ao SKU da fórmula.
  SELECT op.valor_unitario, op.ativo INTO v_base_preco, v_base_ativo
  FROM tint_formulas f
  LEFT JOIN tint_skus s ON s.id = f.sku_id
  LEFT JOIN omie_products op ON op.id = s.omie_product_id
  WHERE f.id = p_formula_id;

  -- Money-path: base inativa no Omie NÃO é vendável (produto descontinuado), mesmo
  -- com valor_unitario congelado > 0. COALESCE(...,false) = paridade VERBATIM com o batch
  -- e robustez se `ativo` virar nullable; produto ausente => v_base_preco NULL já barra
  -- (false AND <qualquer> = false na lógica de 3 valores).
  v_base_disponivel := v_base_preco IS NOT NULL AND v_base_preco > 0 AND COALESCE(v_base_ativo, false);
  v_custo_base := CASE WHEN v_base_disponivel THEN v_base_preco ELSE NULL END;

  -- Corantes: custo só quando o produto Omie do corante tem preço > 0, está ATIVO e
  -- o volume é válido. COALESCE(op.ativo,false): corante sem produto Omie (op NULL via
  -- LEFT JOIN) => indisponível (já barrado por valor=0, mas explícito).
  WITH calc AS (
    SELECT
      fi.ordem,
      COALESCE(c.descricao, '?') AS corante_descricao,
      fi.qtd_ml,
      (COALESCE(op.valor_unitario, 0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0) AS custo_disponivel,
      CASE WHEN COALESCE(op.valor_unitario, 0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0
           THEN op.valor_unitario / c.volume_total_ml ELSE 0 END AS custo_por_ml,
      CASE WHEN COALESCE(op.valor_unitario, 0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0
           THEN fi.qtd_ml * (op.valor_unitario / c.volume_total_ml) ELSE 0 END AS custo_item
    FROM tint_formula_itens fi
    LEFT JOIN tint_corantes c  ON c.id = fi.corante_id
    LEFT JOIN omie_products op ON op.id = c.omie_product_id
    WHERE fi.formula_id = p_formula_id
  )
  SELECT
    COALESCE(SUM(custo_item), 0),
    COALESCE(bool_and(custo_disponivel), false),  -- fórmula sem itens => receita faltando (fail closed), não base pura
    COALESCE(jsonb_agg(jsonb_build_object(
      'coranteDescricao', corante_descricao, 'qtdMl', qtd_ml, 'custoPorMl', custo_por_ml,
      'custoItem', custo_item, 'custoDisponivel', custo_disponivel
    ) ORDER BY ordem), '[]'::jsonb)
  INTO v_custo_corantes, v_corantes_completos, v_itens
  FROM calc;

  -- Money-path: só há preço quando a base existe E todos os corantes têm custo.
  v_preco_final := CASE WHEN v_base_disponivel AND v_corantes_completos
                        THEN v_custo_base + v_custo_corantes ELSE NULL END;

  RETURN jsonb_build_object(
    -- P1: custoBase/custoCorantes são CUSTO comercial → só staff. precoFinal (preço de
    -- venda), baseDisponivel e corantesCompletos ficam VISÍVEIS (o customer vê o preço).
    'custoBase', CASE WHEN v_is_staff THEN v_custo_base ELSE NULL END,
    'baseDisponivel', v_base_disponivel,
    'custoCorantes', CASE WHEN v_is_staff THEN v_custo_corantes ELSE NULL END,
    'corantesCompletos', v_corantes_completos,
    'precoFinal', v_preco_final,
    'itensCorantes', CASE WHEN v_is_staff THEN v_itens ELSE '[]'::jsonb END
  );
END; $function$;

-- ── BATCH (sql) — CTE `staff` computa is_staff 1× + gate de custoBase/custoCorantes ──
-- Copiado VERBATIM da def de PROD; ACRESCENTA o CTE `staff` (CROSS JOIN de 1 linha —
-- has_role/auth.uid avaliados UMA vez, não por fórmula) e envolve custoBase/custoCorantes
-- em CASE WHEN s.is_staff. Ordem das chaves do jsonb preservada (contrato por nome).
CREATE OR REPLACE FUNCTION public.get_tint_prices(p_formula_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- AS MATERIALIZED: barreira de otimização que força has_role a rodar UMA vez (não
  -- por fórmula do agg). STABLE não garante cache entre invocações na mesma query, e o
  -- planner poderia inlinar o CTE dentro do jsonb_build_object. O CROSS JOIN reusa a
  -- única linha. Mesmo espírito do InitPlan (SELECT auth.uid()) de
  -- 20260627150000_tint_formulas_rls_initplan.sql. (recomendação Codex xhigh)
  WITH staff AS MATERIALIZED (
    SELECT (auth.uid() IS NOT NULL
      AND (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))) AS is_staff
  ),
  bases AS (
    SELECT f.id AS formula_id,
           op.valor_unitario AS base_preco,
           (op.valor_unitario IS NOT NULL AND op.valor_unitario > 0 AND COALESCE(op.ativo, false)) AS base_disponivel
    FROM tint_formulas f
    LEFT JOIN tint_skus s ON s.id = f.sku_id
    LEFT JOIN omie_products op ON op.id = s.omie_product_id
    WHERE f.id = ANY(p_formula_ids)
  ),
  corantes AS (
    SELECT fi.formula_id,
           COALESCE(SUM(CASE WHEN COALESCE(op.valor_unitario,0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0
                             THEN fi.qtd_ml * op.valor_unitario / c.volume_total_ml ELSE 0 END), 0) AS custo_corantes,
           COALESCE(bool_and(COALESCE(op.valor_unitario,0) > 0 AND COALESCE(op.ativo, false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0), false) AS corantes_completos
    FROM tint_formula_itens fi
    LEFT JOIN tint_corantes c  ON c.id = fi.corante_id
    LEFT JOIN omie_products op ON op.id = c.omie_product_id
    WHERE fi.formula_id = ANY(p_formula_ids)
    GROUP BY fi.formula_id
  )
  SELECT COALESCE(jsonb_object_agg(b.formula_id, jsonb_build_object(
    -- P1: custo comercial só p/ staff (paridade com a singular). precoFinal/baseDisponivel/
    -- corantesCompletos ficam VISÍVEIS — o customer precisa do preço de venda do balcão.
    'custoBase', CASE WHEN s.is_staff AND b.base_disponivel THEN b.base_preco ELSE NULL END,
    'baseDisponivel', b.base_disponivel,
    'custoCorantes', CASE WHEN s.is_staff THEN COALESCE(co.custo_corantes, 0) ELSE NULL END,
    'corantesCompletos', COALESCE(co.corantes_completos, false),
    'precoFinal', CASE WHEN b.base_disponivel AND COALESCE(co.corantes_completos, false)
                       THEN b.base_preco + COALESCE(co.custo_corantes, 0) ELSE NULL END
  )), '{}'::jsonb)
  FROM bases b
  LEFT JOIN corantes co ON co.formula_id = b.formula_id
  CROSS JOIN staff s;
$function$;

-- Grants: escopo inalterado — só `authenticated` executa (não PUBLIC/anon). CREATE OR
-- REPLACE preserva a ACL; reafirmado por idempotência (espelha 20260615210000/20260616120000).
-- O gate é de PROJEÇÃO (custo→NULL p/ não-staff), NÃO de execução: o customer PRECISA
-- executar p/ ver precoFinal. Revogar authenticated quebraria o balcão.
REVOKE ALL ON FUNCTION public.get_tint_price(uuid)    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tint_price(uuid)  TO authenticated;
REVOKE ALL ON FUNCTION public.get_tint_prices(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_tint_prices(uuid[]) TO authenticated;
