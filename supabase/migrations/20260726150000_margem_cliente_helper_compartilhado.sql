-- Helper COMPARTILHADO de margem por cliente — uma só verdade para os dois consumidores.
--
-- POR QUE ELE EXISTE (medido em prod 2026-07-21): duas frentes simultâneas construíram, cada uma,
-- o "cálculo server-side da margem por cliente":
--   • PR #1495  — `get_customer_margin_summary()`, service_role, alimenta o cron que popula
--                 `farmer_client_scores.gross_margin_pct` (hoje 0 para 6.632/6.632 linhas);
--   • FU4-F f3  — `get_carteira_margem_faixa()`, authenticated, devolve a FAIXA ao browser para
--                 `useFarmerScoring` parar de baixar `product_costs` (3.637 linhas) ao cliente.
-- Rodando as duas lógicas lado a lado sobre a prod: 1.215 clientes, 461 com margem numérica
-- diferente, 310 divergindo em *ser calculável*, delta máximo de 112,57 pontos percentuais e
-- **346 clientes (28,5%) caindo em FAIXA diferente**. Duas autoridades money-path discordando no
-- sinal que o vendedor vê. Este helper é a resposta: ambos passam a derivar daqui.
--
-- ⚠️ MIGRATION MANUAL: nome custom não auto-aplica no Lovable. Colar no SQL Editor → Run.
--
-- ── DECISÃO 1: o JOIN é por `omie_codigo_produto`, não por `order_items.product_id` ───────────
-- `product_id` é NULO em 1.837 de 68.700 itens (2,67%). Desses, **783 TÊM custo conhecido**
-- alcançável por `omie_codigo_produto`, carregando **R$ 247.482,10** de receita — que um JOIN por
-- `product_id` classifica como "sem custo". É a lição "ausente ≠ zero" aplicada à JUNÇÃO: item que
-- não junta não é item sem custo.
-- O JOIN é SET-BASED: `product_costs.product_id` é UNIQUE (`product_costs_product_id_key`) e
-- `omie_products.omie_codigo_produto` é único (7.962/7.962) ⇒ não duplica linha.
--
-- ── DECISÃO 2: o filtro de status PRESERVA o comportamento do HOOK, de propósito ──────────────
-- ⚠️ ELE ESTÁ ERRADO E ISSO É DELIBERADO. O universo real de `sales_orders.status` é
-- `faturado` 20.182 · `importado` 5.269 · `separacao` 2.760 · `enviado` 2.005 · e 17 entre
-- `cancelado`/`orcamento`/`rascunho`. **`confirmado` e `entregue` não existem (zero linhas).**
-- O allowlist abaixo é o de `useFarmerScoring.ts:147`, logo o scoring vivo enxerga só `faturado`:
-- 20.182 de 30.216 pedidos reais — **faltam 33% da base**, e não só para a margem (recência,
-- frequência, spend e mix saem do mesmo universo).
--
-- ⚠️ PRECISÃO: o que se preserva é o comportamento do HOOK (`useFarmerScoring`), que é o que o
-- vendedor vê hoje. NÃO se preserva o do #1495, que usa denylist e nunca rodou em prod (a coluna
-- que ele alimenta está 0 para todos). Ao absorver este helper, o #1495 MUDA de universo — é
-- mudança consciente, não regressão: alinha o cron ao que a tela mostra.
--
-- ⚠️ E o custo de cristalizar: enquanto o follow-up não entrar, este objeto é a "fonte única" que
-- exclui 33% da base. A mitigação é ele ser UM lugar — o chip "Corrigir filtro de status do
-- scoring do farmer" (PR próprio, com baseline medido) muda esta lista e vale para os dois
-- consumidores de uma vez. Sem esse follow-up, a dívida fica; com ele, some de uma vez só.
--
-- ── DECISÃO 3: ausente ≠ zero, nas TRÊS pernas ───────────────────────────────────────────────
-- Um item só é COMPUTÁVEL quando quantidade, preço E custo são utilizáveis. Cliente sem nenhum
-- item computável devolve `margem_pct = NULL`, jamais 0 — margem 0 é veredito legítimo
-- ("cliente ruim") e confundi-lo com "não sei" fabrica número. Margem NEGATIVA é dado real e é
-- preservada. Espelha `src/lib/custo/custoCanonico.ts` e `src/lib/scoring/margin.ts`.
--
-- ── Superfície ───────────────────────────────────────────────────────────────────────────────
-- Fechado por PRIVILÉGIO: `REVOKE` de PUBLIC + anon + authenticated, `GRANT` só a service_role.
-- ⚠️ Viver em `private` fecha a rota HTTP (o PostgREST só publica os schemas configurados) mas
-- NÃO é barreira de EXECUTE: medido, `private` concede USAGE a authenticated E anon
-- (`nspacl = {…,authenticated=U/postgres,anon=U/postgres,…}`). Quem tratar o schema como trava
-- está enganado — é o REVOKE, e só ele. Os consumidores é que carregam o gate.

BEGIN;

CREATE SCHEMA IF NOT EXISTS private;

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
    -- Custo canônico: cost_final (saída do motor, proxy-aware) → fallback cost_price.
    -- `> 0 AND < 'Infinity'` é o teste de FINITUDE POSITIVA em numeric e cobre os três lixos de
    -- uma vez: 0/negativo reprovam no `> 0`; Infinity reprova no `< 'Infinity'`; e NaN reprova
    -- também, porque o Postgres ordena NaN como MAIOR que qualquer numeric, inclusive Infinity.
    -- (Um `NULLIF(x,'NaN')` sozinho deixaria Infinity passar — achado Codex xhigh, 2026-07-21.)
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
      LEFT JOIN custo cu          ON cu.cod = oi.omie_codigo_produto
     -- ⚠️ DECISÃO 2 acima: esta lista é o comportamento VIVO, conhecidamente incompleto.
     -- É o ÚNICO lugar a mudar quando o PR do filtro de status entrar.
     WHERE so.status IN ('confirmado', 'faturado', 'entregue')
       -- 100% NULO hoje; sem isto o 1º pedido soft-deleted entraria no cálculo em silêncio.
       AND so.deleted_at IS NULL
       AND oi.customer_user_id IS NOT NULL
       -- NOT EXISTS, não NOT IN: NOT IN é NULL-blind e zeraria o resultado inteiro.
       AND NOT EXISTS (
             SELECT 1 FROM public.cliente_classificacao cc
              WHERE cc.user_id = oi.customer_user_id
                AND cc.excluir_da_carteira IS TRUE)
  ),
  norm AS (
    -- ⚠️ A versão anterior fazia `COALESCE(quantity,0→1)` e `COALESCE(unit_price,0)`, o que
    -- FABRICAVA margem: item com custo conhecido e preço ausente entrava com receita 0 e custo
    -- real, e um cliente com (100,60) + (preço ausente, custo 40) fechava em 0.00% — veredito
    -- inventado (achado Codex xhigh). A prod tem 0 desses em 68.720 itens, então o guard não
    -- muda número nenhum hoje; ele impede que o primeiro apareça em silêncio.
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
    -- Denominador > 0 é a ÚNICA condição que produz número. Sem item computável (ou receita 0
    -- sobre eles) → NULL. NUNCA 0.
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
  'Consumida por get_customer_margin_summary (cron/service_role) e get_carteira_margem_faixa '
  '(browser, via faixa). ausente<>zero nas TRES pernas: sem item computavel devolve NULL, nunca 0. '
  'JOIN por omie_codigo_produto — product_id e nulo em 2,67% dos itens. Fechada por REVOKE; '
  'o schema private fecha a rota do PostgREST mas NAO o EXECUTE (authenticated tem USAGE nele).';

-- Fechamento por privilégio. Função nova nasce com `proacl = NULL` = EXECUTE implícito a PUBLIC,
-- e o default privilege do Supabase concede às roles nomeadas — revogar dos DOIS jeitos.
REVOKE ALL ON FUNCTION private.margem_cliente_agregada() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.margem_cliente_agregada() FROM anon;
REVOKE ALL ON FUNCTION private.margem_cliente_agregada() FROM authenticated;
GRANT EXECUTE ON FUNCTION private.margem_cliente_agregada() TO service_role;
-- Sem USAGE no schema, o GRANT de EXECUTE é decorativo num banco novo: `has_function_privilege`
-- olha só o ACL da função e devolveria `t` para uma role que na prática não alcança a função
-- (achado Codex xhigh). Em prod o USAGE já existe; aqui é para o objeto ser autossuficiente.
GRANT USAGE ON SCHEMA private TO service_role;

COMMIT;
