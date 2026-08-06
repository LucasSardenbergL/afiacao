-- Reconciliação da margem por cliente — uma função de verdade, um universo de pedidos.
--
-- CONTEXTO: duas frentes entregaram cálculo de margem por cliente com poucos dias de diferença.
--   • #1495  `public.get_customer_margin_summary()` — cron/health score. JOIN por `product_id`,
--            universo por DENYLIST de status.
--   • #1519  `private.margem_cliente_agregada()` — helper compartilhado. JOIN por
--            `omie_codigo_produto`, universo por ALLOWLIST (espelhando `useFarmerScoring`).
-- Nenhuma das duas chegou a rodar em prod (conferido: 0 em `pg_proc` para ambas antes deste PR;
-- `farmer_client_scores.gross_margin_pct` seguia 0 em 6.632/6.632). Esta migration reconcilia
-- ANTES que qualquer número divergente exista — não há flip-flop de valor exibido.
--
-- ── O QUE VENCEU EM CADA EIXO, POR MEDIÇÃO ───────────────────────────────────────────────────
--
-- EIXO 1 — JOIN: vence o #1519 (`omie_codigo_produto`).
--   `order_items.product_id` é NULO em 1.837 de 68.700 itens (2,67%). Desses, **783 TÊM custo
--   conhecido** alcançável pelo código, carregando **R$ 247.482,10** de receita que o JOIN por
--   `product_id` classificava como "sem custo". É "ausente ≠ zero" aplicado à JUNÇÃO: item que não
--   junta não é item sem custo.
--
-- EIXO 2 — UNIVERSO DE STATUS: vence o #1495 (DENYLIST). ⚠️ Aqui o #1519 estava ERRADO, e este é
--   o achado maior deste PR. A allowlist `IN ('confirmado','faturado','entregue')` foi copiada de
--   `useFarmerScoring.ts:147` para "preservar o comportamento vivo" — mas `confirmado` e
--   `entregue` NÃO EXISTEM em `sales_orders` (zero linhas), então ela resolve para **só
--   `faturado`** e descarta vendas reais:
--       faturado  20.207 · R$ 20.220.276,84   ← único que a allowlist enxerga
--       importado  5.271 · R$  2.753.517,63   ┐
--       separacao  2.759 · R$  2.637.938,56   ├ vendas REAIS que a allowlist descartava:
--       enviado    2.005 · R$  1.593.969,47   ┘ R$ 6.985.425,66 (26% do faturamento)
--       cancelado     15 · orcamento 1 · rascunho 1  ← as duas listas excluem, corretamente
--   Efeito medido de adotar o universo amplo (JOIN mantido constante, 1.216 clientes):
--     · **311 clientes (25,6%) que a allowlist não conseguia calcular passam a ter margem real**
--       — com a allowlist eles caíam em `neutro`, ou seja, o sinal sumia da tela;
--     · 345 clientes (28,4%) mudam de faixa; delta médio 2,97 pp, máximo 112,42 pp.
--   Preservar um comportamento medidamente errado não é conservador — é congelar o erro numa
--   "fonte única" e multiplicá-lo pelos dois consumidores.
--
-- EIXO 3 — guards de qualidade: vence o #1519 (as três pernas computáveis + finitude).
--   Mantidos como estão no helper; o #1495 fabricava margem com `COALESCE(unit_price,0)`.
--
-- ⚠️ CONSEQUÊNCIA PARA O `useFarmerScoring` (FU4-F fase 3): ao consumir o helper, o hook passa a
-- enxergar o universo amplo. Isso corrige a margem, mas as OUTRAS métricas do hook (recência,
-- frequência, spend, mix) continuam lendo `sales_orders` com a allowlist local — o chip "Corrigir
-- filtro de status do scoring do farmer" segue aberto para elas. Este PR fecha o eixo da MARGEM.
--
-- ── LIMITAÇÃO CONHECIDA E MEDIDA: pedido Omie duplicado em dois status ───────────────────────
-- A denylist herda um defeito de DADO que a allowlist mascarava: existem **24 pares
-- (account, omie_pedido_id)** gravados como DUAS linhas de `sales_orders` com status diferentes
-- (tipicamente `faturado` + `enviado`), mesmo cliente e mesma conta. A allowlist via só
-- `faturado` e pegava uma; a denylist enxerga as duas e conta os itens em dobro.
-- Medido em 2026-07-21 (deduplicando por `(account, omie_pedido_id)`, ficando com o status mais
-- avançado): **3 clientes** mudam de margem, delta máximo **0,61 pp**, e **ZERO** mudam de faixa.
-- ⇒ NÃO deduplicado aqui, de propósito. A causa é um bug de SYNC (duas linhas para um pedido) que
-- afeta igualmente receita, frequência e spend; corrigir só dentro da margem mascararia o
-- problema upstream e acrescentaria uma window function ao caminho quente por 0,61 pp em 3 de
-- 1.224 clientes. Follow-up: investigar o writer que duplica no `omie-vendas-sync`.
-- Se algum dia esses 24 virarem centenas, o efeito deixa de ser imaterial — remeça antes de
-- assumir que continua.
--
-- ⚠️ MIGRATION MANUAL: nome custom não auto-aplica no Lovable. Colar no SQL Editor → Run.
-- Ordem: esta migration DEPOIS de `20260723150000` e `20260726150000` (recria objetos das duas).

BEGIN;

-- ── 1. O helper adota o universo amplo ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.margem_cliente_agregada()
RETURNS TABLE (
  customer_user_id  uuid,
  itens_computaveis bigint,
  itens_ignorados   bigint,
  receita_computada numeric,
  custo_computado   numeric,
  margem_pct        numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
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
    SELECT i.cid, i.qtd, i.preco_unit, i.custo_unit,
           ( i.qtd        IS NOT NULL AND i.qtd        >  0 AND i.qtd        < 'Infinity'::numeric
         AND i.preco_unit IS NOT NULL AND i.preco_unit >= 0 AND i.preco_unit < 'Infinity'::numeric
         AND i.custo_unit IS NOT NULL ) AS computavel
      FROM itens i
  )
  SELECT
    n.cid,
    count(*) FILTER (WHERE n.computavel),
    count(*) FILTER (WHERE NOT n.computavel),
    COALESCE(sum(n.preco_unit * n.qtd)  FILTER (WHERE n.computavel), 0),
    COALESCE(sum(n.custo_unit  * n.qtd) FILTER (WHERE n.computavel), 0),
    CASE
      WHEN COALESCE(sum(n.preco_unit * n.qtd) FILTER (WHERE n.computavel), 0) > 0
      THEN round(
             ( sum(n.preco_unit * n.qtd)  FILTER (WHERE n.computavel)
             - sum(n.custo_unit  * n.qtd) FILTER (WHERE n.computavel) )
             / sum(n.preco_unit * n.qtd)  FILTER (WHERE n.computavel) * 100
           , 2)
      ELSE NULL
    END
  FROM norm n
  GROUP BY n.cid;
$fn$;

COMMENT ON FUNCTION private.margem_cliente_agregada() IS
  'Fonte UNICA da margem bruta por cliente (order_items x omie_products x product_costs). '
  'Universo por DENYLIST de status (inclui separacao/enviado/importado: sao vendas reais, '
  'R$ 6.985.425,66 que a allowlist anterior descartava). JOIN por omie_codigo_produto — '
  'product_id e nulo em 2,67% dos itens. ausente<>zero nas TRES pernas: sem item computavel '
  'devolve NULL, nunca 0. Fechada por REVOKE; o schema private fecha a rota do PostgREST mas '
  'NAO o EXECUTE (authenticated tem USAGE nele).';

-- Reafirmar o fechamento: `CREATE OR REPLACE` preserva a ACL, mas repetir é barato e imuniza
-- contra a função ter sido recriada à mão sem os REVOKE no intervalo.
REVOKE ALL ON FUNCTION private.margem_cliente_agregada() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.margem_cliente_agregada() FROM anon;
REVOKE ALL ON FUNCTION private.margem_cliente_agregada() FROM authenticated;
GRANT EXECUTE ON FUNCTION private.margem_cliente_agregada() TO service_role;
GRANT USAGE ON SCHEMA private TO service_role;

-- ── 2. `get_customer_margin_summary` vira PROJEÇÃO do helper ─────────────────────────────────
-- Assinatura e nomes de coluna PRESERVADOS: a edge `calculate-scores` consome estes nomes e não
-- muda. O que muda é de onde o número vem — e, com ele, os três eixos acima.
CREATE OR REPLACE FUNCTION public.get_customer_margin_summary()
RETURNS TABLE(
  customer_user_id  uuid,
  itens_com_custo   bigint,
  itens_sem_custo   bigint,
  receita_com_custo numeric,
  custo_conhecido   numeric,
  gross_margin_pct  numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT m.customer_user_id,
         m.itens_computaveis,
         m.itens_ignorados,
         m.receita_computada,
         m.custo_computado,
         m.margem_pct
    FROM private.margem_cliente_agregada() m;
$function$;

COMMENT ON FUNCTION public.get_customer_margin_summary() IS
  'Margem bruta por cliente para o componente de margem do health score. Desde a reconciliacao '
  '(2026-07-21) e uma PROJECAO de private.margem_cliente_agregada() — nao tem calculo proprio. '
  'Nomes de coluna preservados para a edge calculate-scores. ausente<>zero: cliente sem item '
  'computavel devolve NULL, nunca 0. SECURITY DEFINER + EXECUTE so para service_role.';

REVOKE ALL ON FUNCTION public.get_customer_margin_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_margin_summary() FROM anon;
REVOKE ALL ON FUNCTION public.get_customer_margin_summary() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_margin_summary() TO service_role;

COMMIT;
