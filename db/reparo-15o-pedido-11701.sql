-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║ REPARO do 15º pedido — 11701 / omie 12121128593 (conta oben, faturado)        ║
-- ║                                                                              ║
-- ║ POR QUE ESTE VEIO SEPARADO: no reparo dos 14 eu o SUSPENDI de propósito. O    ║
-- ║ jsonb dizia 1×221,80 onde o banco dizia 2×110,90, e 221,80 = exatamente       ║
-- ║ 2 × 110,90 — parecia quantidade colapsada dentro do preço (o SKU nunca passou ║
-- ║ de 180,95 em 171 referências; as linhas irmãs do MESMO SKU no MESMO pedido    ║
-- ║ são 2×105,90 e 2×119,90). Precisão > recall: não reparei, perguntei.          ║
-- ║                                                                              ║
-- ║ O QUE DESEMPATOU: o founder consultou o OMIE (2026-09-08) e o Omie diz        ║
-- ║ 1 unidade a R$ 221,80. O Omie é o árbitro; a heurística de preço era só isso. ║
-- ║                                                                              ║
-- ║ O QUE MUDA: uma linha. 2 × 110,90 vira 1 × 221,80. Mesmo dinheiro             ║
-- ║ (R$ 221,80), uma unidade a menos no sinal de demanda — que é o ponto.         ║
-- ║ NÃO toca `sales_orders`: total, subtotal e items ficam byte-a-byte iguais.    ║
-- ║                                                                              ║
-- ║ Mesmo mecanismo já provado no reparo dos 14 (DELETE+INSERT do jsonb, na       ║
-- ║ MESMA transação — é o que a CONSTRAINT TRIGGER da 20260907220000 exige).      ║
-- ║                                                                              ║
-- ║ NÃO é idempotente, de propósito: rodar de novo ABORTA com "[PRE] JA           ║
-- ║ APLICADO". A pré-condição ancora no estado exato que foi conferido no Omie,   ║
-- ║ então re-colar não reescreve nada às cegas. Abortar aqui é o comportamento    ║
-- ║ certo, não um erro. Rode no SQL Editor do Lovable.                            ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

BEGIN;

CREATE TEMP TABLE _alvo_15 ON COMMIT DROP AS
SELECT so.id, so.omie_pedido_id, so.account, so.customer_user_id, so.total
FROM public.sales_orders so
WHERE so.omie_pedido_id = 12121128593
  AND so.hash_payload IS NOT NULL          -- só a linha canônica do pedido
FOR UPDATE;                                -- serializa contra o sync de 2 em 2 h

-- ────────────────────────────────────────────────────────────────────────────
-- PRÉ-CONDIÇÃO: fail-closed. Ancorada no estado EXATO que o founder consultou
-- no Omie. Se qualquer lado se mexeu desde então, aborta inteiro em vez de
-- aplicar sobre uma realidade diferente da que foi verificada.
-- ────────────────────────────────────────────────────────────────────────────
DO $pre$
DECLARE v_n int; v_linha_velha int; v_ja int; v_json_novo int; v_prod_nulo int; v_sem_produto int;
BEGIN
  SELECT count(*) INTO v_n FROM _alvo_15;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '[PRE] esperava 1 pedido canonico (omie 12121128593), achei %', v_n;
  END IF;

  SELECT count(*) INTO v_linha_velha
  FROM public.order_items oi JOIN _alvo_15 a ON a.id = oi.sales_order_id
  WHERE oi.omie_codigo_produto = 8689743515
    AND oi.quantity = 2 AND oi.unit_price = 110.90;

  SELECT count(*) INTO v_ja
  FROM public.order_items oi JOIN _alvo_15 a ON a.id = oi.sales_order_id
  WHERE oi.omie_codigo_produto = 8689743515
    AND oi.quantity = 1 AND oi.unit_price = 221.80;

  -- Re-colada: o estado-alvo ja esta la. Aborta com mensagem que DIZ isso, em vez
  -- de deixar o founder lendo um erro obscuro e achando que quebrou algo.
  IF v_linha_velha = 0 AND v_ja = 1 THEN
    RAISE EXCEPTION '[PRE] JA APLICADO: a linha ja e 1x221,80. Nada a fazer — isto NAO e um erro.';
  END IF;

  -- o lado que o Omie CONTRADIZ tem de estar exatamente como eu medi
  IF v_linha_velha <> 1 THEN
    RAISE EXCEPTION '[PRE] esperava 1 linha 2x110,90 do SKU 8689743515, achei % — o banco mudou desde a consulta ao Omie; NAO aplique as cegas', v_linha_velha;
  END IF;

  -- o lado que o Omie CONFIRMA tem de continuar dizendo o que dizia
  SELECT count(*) INTO v_json_novo
  FROM _alvo_15 a JOIN public.sales_orders so ON so.id = a.id
  CROSS JOIN LATERAL jsonb_array_elements(so.items) el
  WHERE (el->>'omie_codigo_produto')::bigint = 8689743515
    AND (el->>'quantidade')::numeric = 1
    AND (el->>'valor_unitario')::numeric = 221.80;
  IF v_json_novo <> 1 THEN
    RAISE EXCEPTION '[PRE] o jsonb nao diz mais 1x221,80 do SKU 8689743515 (achei % ocorrencia(s)) — o sync reescreveu; reveja antes de aplicar', v_json_novo;
  END IF;

  -- `ausente != zero`: linha de jsonb sem codigo de produto nao vira order_item
  SELECT count(*) INTO v_prod_nulo
  FROM _alvo_15 a JOIN public.sales_orders so ON so.id = a.id
  CROSS JOIN LATERAL jsonb_array_elements(so.items) el
  WHERE (el->>'omie_codigo_produto') IS NULL;
  IF v_prod_nulo > 0 THEN
    RAISE EXCEPTION '[PRE] % linha(s) de jsonb sem omie_codigo_produto — reparo nao igualaria os lados', v_prod_nulo;
  END IF;

  -- product_id e FK para omie_products
  SELECT count(DISTINCT (el->>'omie_codigo_produto')::bigint) INTO v_sem_produto
  FROM _alvo_15 a JOIN public.sales_orders so ON so.id = a.id
  CROSS JOIN LATERAL jsonb_array_elements(so.items) el
  WHERE NOT EXISTS (SELECT 1 FROM public.omie_products p
                     WHERE p.omie_codigo_produto = (el->>'omie_codigo_produto')::bigint);
  IF v_sem_produto > 0 THEN
    RAISE EXCEPTION '[PRE] % SKU(s) do jsonb sem cadastro em omie_products', v_sem_produto;
  END IF;
END
$pre$;

DELETE FROM public.order_items oi
USING _alvo_15 a
WHERE oi.sales_order_id = a.id;

INSERT INTO public.order_items (
  sales_order_id, customer_user_id, product_id, omie_codigo_produto,
  quantity, unit_price, discount, hash_payload, omie_codigo_item)
SELECT
  a.id,
  a.customer_user_id,
  (SELECT p.id FROM public.omie_products p
    WHERE p.omie_codigo_produto = (el->>'omie_codigo_produto')::bigint),
  (el->>'omie_codigo_produto')::bigint,
  (el->>'quantidade')::numeric,
  (el->>'valor_unitario')::numeric,
  -- desconto EXPLICITO, nunca o DEFAULT 0 da coluna: chave ausente vira NULL
  (el->>'desconto')::numeric,
  'omie_' || a.account || '_' || a.omie_pedido_id || '_' || (el->>'omie_codigo_produto'),
  NULL::bigint
FROM _alvo_15 a
JOIN public.sales_orders so ON so.id = a.id
CROSS JOIN LATERAL jsonb_array_elements(so.items) el;
-- created_at NAO e passado: `trg_order_items_created_at_omie` faz a linha herdar
-- a DATA DO PEDIDO (30/06/2026), nao a do reparo.

-- ────────────────────────────────────────────────────────────────────────────
-- POSTCONDIÇÃO — predicado idêntico ao de `pedido_venda_exigir_coerencia`,
-- invertido, mais a conferência de dinheiro.
-- ────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE v_div int; v_linhas int; v_visivel numeric; v_cab numeric; v_nova int;
BEGIN
  WITH rel AS (
    SELECT oi.sales_order_id AS id, oi.omie_codigo_produto AS prod, oi.quantity AS qtd,
           oi.unit_price AS preco, oi.discount AS desc_item
    FROM public.order_items oi JOIN _alvo_15 a ON a.id = oi.sales_order_id),
  js AS (
    SELECT so.id, (el->>'omie_codigo_produto')::bigint, (el->>'quantidade')::numeric,
           (el->>'valor_unitario')::numeric, (el->>'desconto')::numeric
    FROM public.sales_orders so JOIN _alvo_15 a ON a.id = so.id
    CROSS JOIN LATERAL jsonb_array_elements(so.items) el),
  dif AS (
    SELECT id FROM (TABLE rel EXCEPT ALL TABLE js) x
    UNION ALL
    SELECT id FROM (TABLE js EXCEPT ALL TABLE rel) y)
  SELECT count(DISTINCT id) INTO v_div FROM dif;
  IF v_div <> 0 THEN
    RAISE EXCEPTION '[POST] o pedido AINDA diverge — a trigger de coerencia continuaria reprovando; nada foi commitado';
  END IF;

  SELECT count(*) INTO v_linhas
  FROM public.order_items oi JOIN _alvo_15 a ON a.id = oi.sales_order_id;
  IF v_linhas <> 6 THEN
    RAISE EXCEPTION '[POST] esperava 6 linhas no pedido, achei % — o jsonb mudou desde a medicao', v_linhas;
  END IF;

  -- a linha nova existe e a velha sumiu
  SELECT count(*) INTO v_nova
  FROM public.order_items oi JOIN _alvo_15 a ON a.id = oi.sales_order_id
  WHERE oi.omie_codigo_produto = 8689743515 AND oi.quantity = 1 AND oi.unit_price = 221.80;
  IF v_nova <> 1 THEN
    RAISE EXCEPTION '[POST] a linha 1x221,80 nao ficou de pe (achei %)', v_nova;
  END IF;

  -- DINHEIRO: a soma visivel tem de continuar batendo com o cabecalho ja emitido
  SELECT sum(oi.quantity * oi.unit_price - coalesce(oi.discount, 0)) INTO v_visivel
  FROM public.order_items oi JOIN _alvo_15 a ON a.id = oi.sales_order_id;
  SELECT a.total INTO v_cab FROM _alvo_15 a;
  IF round(v_visivel, 2) <> round(v_cab, 2) THEN
    RAISE EXCEPTION '[POST] soma visivel % <> total do cabecalho % — o reparo mexeu no dinheiro; nada foi commitado', v_visivel, v_cab;
  END IF;
END
$post$;

COMMIT;
