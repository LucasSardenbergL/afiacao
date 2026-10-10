-- Margem por cliente: SÓ itens de pedidos dos últimos 12 meses móveis. [money-path]
--
-- Decisão de produto (founder, 2026-10-09). `product_costs` é um retrato do custo ATUAL; aplicá-lo a
-- preços de venda de 2020–2024 deprime a margem (~5 p.p. de viés para baixo no agregado: 40,49% lifetime
-- × 45,47% em 12m, mesmo universo). 12m equilibra precisão e cobertura (502 clientes c/ margem × 385 em
-- 6m, que é volátil). Tabela completa e motivo: docs/historico/farmer-margem-cobertura-custo.md.
--
-- Mudança ÚNICA: `AND so.created_at >= now() - interval '12 months'` no CTE `itens`. `created_at` É a
-- data do pedido (psql-ro 2026-10-09: 0 de 31.783 pedidos divergem > 3 dias de `order_date_kpi`).
-- Todo o resto é o corpo de PROD verbatim (pg_get_functiondef, 2026-10-09): denylist de status,
-- deleted_at, excluir_da_carteira, as 3 pernas computáveis, custo cost_final→cost_price só se > 0 e finito.
--
-- ausente≠zero: cliente sem item no período SOME do resultado → os consumidores (calculate-scores,
-- get_customer_margin_summary, get_carteira_margem_faixa) já tratam ausente como NULL, nunca 0.
--
-- CREATE OR REPLACE (não DROP+CREATE): mesma assinatura, preserva o ACL. O REVOKE/GRANT abaixo é
-- reemitido mesmo assim (idempotente), nomeando as roles. Efeito na tela: a margem persistida em
-- farmer_client_scores se ajusta no próximo cron de calculate-scores (06:00/06:25 UTC), sem deploy de edge.
BEGIN;

CREATE OR REPLACE FUNCTION private.margem_cliente_agregada()
 RETURNS TABLE(customer_user_id uuid, itens_computaveis bigint, itens_ignorados bigint, receita_computada numeric, custo_computado numeric, margem_pct numeric, itens_sem_preco bigint, itens_sem_custo bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  WITH custo AS (
    -- `> 0 AND < 'Infinity'` é o teste de FINITUDE POSITIVA em numeric e cobre os três lixos de
    -- uma vez: 0/negativo reprovam no `> 0`; Infinity reprova no `< 'Infinity'`; e NaN reprova
    -- também, porque o Postgres ordena NaN como MAIOR que qualquer numeric, inclusive Infinity.
    SELECT op.omie_codigo_produto AS cod,
           COALESCE(
             CASE WHEN pc.cost_final > 0 AND pc.cost_final < 'Infinity'::numeric THEN pc.cost_final END,
             CASE WHEN pc.cost_price > 0 AND pc.cost_price < 'Infinity'::numeric THEN pc.cost_price END
           ) AS custo_unit
      FROM public.omie_products op
      JOIN public.product_costs pc ON pc.product_id = op.id
     WHERE op.omie_codigo_produto IS NOT NULL
  ),
  itens AS (
    SELECT oi.customer_user_id      AS cid,
           oi.quantity::numeric     AS qtd,
           oi.unit_price::numeric   AS preco_unit,
           cu.custo_unit
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
      -- EIXO 1: JOIN set-based por código. `product_costs.product_id` é UNIQUE e
      -- `omie_products.omie_codigo_produto` é único (7.962/7.962) ⇒ não duplica linha.
      LEFT JOIN custo cu          ON cu.cod = oi.omie_codigo_produto
     -- EIXO 2: DENYLIST. Só o que não é venda sai; todo status de venda real entra, inclusive os
     -- em trânsito (`separacao`, `enviado`) e os importados do Omie.
     WHERE so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
       AND so.deleted_at IS NULL
       -- JANELA (2026-10-09): só pedidos dos últimos 12 meses móveis — o custo é o ATUAL, e aplicá-lo
       -- a preço de anos atrás deprime a margem. Sem compra no período → cliente fora (NULL, não 0).
       AND so.created_at >= now() - interval '12 months'
       AND oi.customer_user_id IS NOT NULL
       -- NOT EXISTS, não NOT IN: NOT IN é NULL-blind e zeraria o resultado inteiro.
       AND NOT EXISTS (
             SELECT 1 FROM public.cliente_classificacao cc
              WHERE cc.user_id = oi.customer_user_id
                AND cc.excluir_da_carteira IS TRUE)
  ),
  norm AS (
    -- EIXO 3: um item só conta com as TRÊS pernas utilizáveis. `COALESCE(unit_price,0)` fabricava
    -- margem: item com custo conhecido e preço ausente entrava com receita 0 e custo real.
    --
    -- ⚠️ O preço usa `> 0`, não `>= 0`. Enquanto `order_items.unit_price` foi NOT NULL DEFAULT 0,
    -- "não sei o preço" chegava aqui como 0 — e `0 >= 0` é TRUE, então o item era COMPUTÁVEL e
    -- fabricava a margem negativa que este bloco existe para impedir. O `IS NOT NULL` sozinho era
    -- um ramo MORTO (a coluna não podia ser NULL). Régua idêntica à do custo, acima, e à do TS
    -- (`valorMedido(...)` + `> 0` em src/lib/scoring/margin.ts).
    --
    -- Um 0 legítimo (bonificação/brinde) também sai da margem, de propósito: receita 0 com custo
    -- real é margem -100%, que envenenaria o agregado. Ele fica visível em `itens_sem_preco`.
    SELECT i.cid, i.qtd, i.preco_unit, i.custo_unit,
           ( i.qtd IS NOT NULL AND i.qtd > 0 AND i.qtd < 'Infinity'::numeric )       AS qtd_ok,
           ( i.preco_unit IS NOT NULL AND i.preco_unit > 0
             AND i.preco_unit < 'Infinity'::numeric )                                AS preco_ok,
           ( i.custo_unit IS NOT NULL )                                              AS custo_ok
      FROM itens i
  ),
  flag AS (
    SELECT n.*, (n.qtd_ok AND n.preco_ok AND n.custo_ok) AS computavel FROM norm n
  )
  SELECT
    f.cid,
    count(*) FILTER (WHERE f.computavel),
    count(*) FILTER (WHERE NOT f.computavel),
    COALESCE(sum(f.preco_unit * f.qtd)  FILTER (WHERE f.computavel), 0),
    COALESCE(sum(f.custo_unit  * f.qtd) FILTER (WHERE f.computavel), 0),
    CASE
      WHEN COALESCE(sum(f.preco_unit * f.qtd) FILTER (WHERE f.computavel), 0) > 0
      THEN round(
             ( sum(f.preco_unit * f.qtd)  FILTER (WHERE f.computavel)
             - sum(f.custo_unit  * f.qtd) FILTER (WHERE f.computavel) )
             / sum(f.preco_unit * f.qtd)  FILTER (WHERE f.computavel) * 100
           , 2)
      ELSE NULL
    END,
    -- ⚠️ COBERTURA POR MOTIVO — as duas contagens SE SOBREPÕEM, de propósito: um item sem preço E
    -- sem custo conta nas DUAS. Elas não particionam `itens_ignorados` e não somam para ele. Cada
    -- uma responde a sua pergunta ("quantos itens não sei precificar?" / "…custear?"); forçá-las a
    -- somar exigiria eleger um motivo "principal" — uma escolha arbitrária apresentada como fato.
    count(*) FILTER (WHERE NOT f.preco_ok),
    count(*) FILTER (WHERE NOT f.custo_ok)
  FROM flag f
  GROUP BY f.cid;
$function$
;

COMMENT ON FUNCTION private.margem_cliente_agregada() IS
  'Fonte UNICA da margem bruta por cliente (order_items x omie_products x product_costs). '
  'JANELA: so itens de pedidos dos ULTIMOS 12 MESES moveis (sales_orders.created_at) — o custo e o '
  'atual e nao vale para preco de anos atras (decisao 2026-10-09); cliente sem compra no periodo nao '
  'aparece (NULL, nunca 0). Universo por DENYLIST de status (inclui separacao/enviado/importado: sao '
  'vendas reais). JOIN por omie_codigo_produto — product_id e nulo em 2,67% dos itens. ausente<>zero '
  'nas TRES pernas: sem item computavel devolve NULL, nunca 0. Preco exige > 0 (nao >= 0): enquanto '
  'unit_price foi NOT NULL DEFAULT 0, preco ausente chegava como 0 e era computavel — margem negativa '
  'fabricada. itens_sem_preco e itens_sem_custo SE SOBREPOEM (item sem os dois conta nas duas) e NAO '
  'somam itens_ignorados.';

REVOKE ALL ON FUNCTION private.margem_cliente_agregada() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.margem_cliente_agregada() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION private.margem_cliente_agregada() TO service_role;

-- Pós-condição DENTRO da transação: qualquer falha aborta tudo (nada fica meio-aplicado).
DO $pos$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private' AND p.proname = 'margem_cliente_agregada' AND p.prokind = 'f';
  IF v_src IS NULL OR position('interval ''12 months''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POS 1: margem_cliente_agregada sem a janela de 12 meses';
  END IF;
  IF position('i.preco_unit > 0' IN v_src) = 0 OR position('excluir_da_carteira IS TRUE' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POS 2: margem_cliente_agregada perdeu regra preexistente (preco > 0 / excluir_da_carteira)';
  END IF;
  IF has_function_privilege('anon', 'private.margem_cliente_agregada()', 'EXECUTE')
  OR has_function_privilege('authenticated', 'private.margem_cliente_agregada()', 'EXECUTE')
  OR NOT has_function_privilege('service_role', 'private.margem_cliente_agregada()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS 3: ACL de margem_cliente_agregada fora do desenho (so service_role executa)';
  END IF;
  PERFORM count(*) FROM private.margem_cliente_agregada();  -- late-bound: EXECUTA, não só cria
  RAISE NOTICE 'MARGEM_JANELA_12M_OK';
END
$pos$;

COMMIT;
