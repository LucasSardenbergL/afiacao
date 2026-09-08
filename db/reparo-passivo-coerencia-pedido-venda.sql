-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║ REPARO do passivo de coerência do agregado PEDIDO DE VENDA (PR #2363)         ║
-- ║                                                                              ║
-- ║ O QUE FAZ: reconstrói `order_items` a partir de `sales_orders.items` (jsonb)  ║
-- ║ nos pedidos em que os dois lados descrevem conjuntos diferentes.              ║
-- ║                                                                              ║
-- ║ O QUE NÃO FAZ: NÃO toca `sales_orders`. `total`, `subtotal` e `items` ficam   ║
-- ║ byte-a-byte como estão. Nenhum valor de nota fiscal é alterado por este SQL.  ║
-- ║ O que muda é a TABELA DERIVADA que o money-path lê, que hoje discorda do      ║
-- ║ cabeçalho que a própria empresa já emitiu.                                    ║
-- ║                                                                              ║
-- ║ Medido em prod 2026-09-07 via psql-ro. Rode no SQL Editor do Lovable.         ║
-- ║ Idempotente: rodar de novo converge para o mesmo estado.                      ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- BLOCO 1 — os 14 pedidos com direção de reparo defensável.
-- Fora daqui de propósito: 12121128593 (o jsonb parece ter colapsado a
-- quantidade dentro do preço: 1×221,80 onde o banco diz 2×110,90; as linhas
-- irmãs do mesmo SKU no MESMO pedido são 2×105,90 e 2×119,90, o catálogo é
-- 144,20 e o preço nunca passou de 180,95 em nenhum outro pedido). Reparar
-- aquele pela regra geral APAGARIA 1 unidade de demanda sem base para isso.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _alvo_reparo ON COMMIT DROP AS
SELECT so.id, so.omie_pedido_id, so.account, so.customer_user_id
FROM public.sales_orders so
WHERE so.omie_pedido_id IN (
        12098848089, 12098907348, 12099420341, 12101768638, 12101775770,
        12104022506, 12127942977, 12128013807, 12129511432, 12137805363,
        12153747325, 12155972321, 12156120068, 12163560448)
  AND so.hash_payload IS NOT NULL          -- só a linha canônica do pedido
ORDER BY so.id
FOR UPDATE;                                -- serializa contra o sync de 2 em 2 h

-- PRÉ-CONDIÇÃO: fail-closed. Se o sync mexeu em algo entre a medição e o Run,
-- a contagem não fecha e o reparo aborta INTEIRO em vez de aplicar meio certo.
DO $pre$
DECLARE v_n int; v_prod_nulo int; v_sem_produto int;
BEGIN
  SELECT count(*) INTO v_n FROM _alvo_reparo;
  IF v_n <> 14 THEN
    RAISE EXCEPTION '[PRE] esperava 14 pedidos canonicos, achei % — o alvo mudou desde a medicao de 2026-09-07; nao aplique as cegas', v_n;
  END IF;

  -- `ausente != zero`: linha de jsonb sem codigo de produto nao vira order_item
  -- (o escritor canonico filtra por IS NOT NULL). Se aparecer uma, o reparo NAO
  -- consegue igualar os dois lados e a trigger continuaria reprovando o pedido.
  SELECT count(*) INTO v_prod_nulo
  FROM _alvo_reparo a JOIN public.sales_orders so ON so.id = a.id
  CROSS JOIN LATERAL jsonb_array_elements(so.items) el
  WHERE (el->>'omie_codigo_produto') IS NULL;
  IF v_prod_nulo > 0 THEN
    RAISE EXCEPTION '[PRE] % linha(s) de jsonb sem omie_codigo_produto — reparo nao igualaria os lados', v_prod_nulo;
  END IF;

  -- product_id e FK para omie_products: sem cadastro, o INSERT quebraria
  SELECT count(DISTINCT (el->>'omie_codigo_produto')::bigint) INTO v_sem_produto
  FROM _alvo_reparo a JOIN public.sales_orders so ON so.id = a.id
  CROSS JOIN LATERAL jsonb_array_elements(so.items) el
  WHERE NOT EXISTS (SELECT 1 FROM public.omie_products p
                     WHERE p.omie_codigo_produto = (el->>'omie_codigo_produto')::bigint);
  IF v_sem_produto > 0 THEN
    RAISE EXCEPTION '[PRE] % SKU(s) do jsonb sem cadastro em omie_products', v_sem_produto;
  END IF;
END
$pre$;

-- ────────────────────────────────────────────────────────────────────────────
-- O reparo: apaga as linhas do pedido e reescreve a partir do jsonb.
-- DELETE e INSERT na MESMA transação — é o que a CONSTRAINT TRIGGER
-- (DEFERRABLE INITIALLY DEFERRED) da migration 20260907220000 exige. Este SQL
-- funciona igual ANTES ou DEPOIS de ela ser aplicada.
-- ────────────────────────────────────────────────────────────────────────────
DELETE FROM public.order_items oi
USING _alvo_reparo a
WHERE oi.sales_order_id = a.id;

INSERT INTO public.order_items (
  sales_order_id, customer_user_id, product_id, omie_codigo_produto,
  quantity, unit_price, discount, hash_payload, omie_codigo_item)
SELECT
  a.id,
  a.customer_user_id,                                    -- 54/54 iguais ao cabeçalho hoje
  (SELECT p.id FROM public.omie_products p
    WHERE p.omie_codigo_produto = (el->>'omie_codigo_produto')::bigint),
  (el->>'omie_codigo_produto')::bigint,
  (el->>'quantidade')::numeric,
  (el->>'valor_unitario')::numeric,
  -- desconto EXPLÍCITO, nunca o DEFAULT 0 da coluna: chave ausente tem de virar
  -- NULL, senão `ausente` viraria `zero` e a trigger reprovaria (NULL casa com
  -- NULL no EXCEPT ALL; NULL nunca casa com 0).
  (el->>'desconto')::numeric,
  'omie_' || a.account || '_' || a.omie_pedido_id || '_' || (el->>'omie_codigo_produto'),
  NULL::bigint                                           -- o jsonb não carrega identidade de linha
FROM _alvo_reparo a
JOIN public.sales_orders so ON so.id = a.id
CROSS JOIN LATERAL jsonb_array_elements(so.items) el;
-- created_at NÃO é passado de propósito: a trigger BEFORE INSERT
-- `trg_order_items_created_at_omie` faz a linha herdar a DATA DO PEDIDO do pai,
-- não a data do reparo. É o que mantém a receita atribuída ao mês certo.

-- ────────────────────────────────────────────────────────────────────────────
-- POSTCONDIÇÃO — o predicado é o MESMO de `pedido_venda_exigir_coerencia`,
-- invertido. Se o reparo não igualou os dois lados, aborta com o motivo escrito
-- em vez de commitar meio-feito.
-- ────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE v_div int; v_linhas int;
BEGIN
  WITH rel AS (
    SELECT oi.sales_order_id AS id, oi.omie_codigo_produto AS prod, oi.quantity AS qtd,
           oi.unit_price AS preco, oi.discount AS desc_item
    FROM public.order_items oi JOIN _alvo_reparo a ON a.id = oi.sales_order_id),
  js AS (
    SELECT so.id, (el->>'omie_codigo_produto')::bigint AS prod,
           (el->>'quantidade')::numeric AS qtd, (el->>'valor_unitario')::numeric AS preco,
           (el->>'desconto')::numeric AS desc_item
    FROM public.sales_orders so JOIN _alvo_reparo a ON a.id = so.id
    CROSS JOIN LATERAL jsonb_array_elements(so.items) el),
  dif AS (
    SELECT id FROM (TABLE rel EXCEPT ALL TABLE js) x
    UNION ALL
    SELECT id FROM (TABLE js EXCEPT ALL TABLE rel) y)
  SELECT count(DISTINCT id) INTO v_div FROM dif;

  IF v_div <> 0 THEN
    RAISE EXCEPTION '[POST] % pedido(s) do alvo AINDA divergem — a trigger de coerencia continuaria reprovando; nada foi commitado', v_div;
  END IF;

  SELECT count(*) INTO v_linhas
  FROM public.order_items oi JOIN _alvo_reparo a ON a.id = oi.sales_order_id;
  IF v_linhas <> 77 THEN
    RAISE EXCEPTION '[POST] esperava 77 linhas nos 14 pedidos, achei % — o jsonb mudou desde a medicao', v_linhas;
  END IF;
END
$post$;

COMMIT;
