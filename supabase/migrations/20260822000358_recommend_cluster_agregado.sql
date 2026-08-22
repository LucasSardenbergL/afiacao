-- ============================================================
-- recommend_cluster_agregado — o `sim_score` do motor de recomendação, agregado no BANCO.
--
-- POR QUE EXISTE (medido em prod 2026-08-21/22 via psql-ro, ref fzvklzpomgnyikkfkzai).
-- `carregarCluster` lia `order_items` dos 50 clientes amostrados com
-- `.order("id").limit(1000)`. Como `order_items.id` é UUID `gen_random_uuid()`, esse LIMIT
-- é amostra de LINHAS, não janela temporal — e o teto MORDIA:
--
--   cluster | linhas existentes | linhas VISTAS | clientes com compra REAL | clientes ZERADOS
--   critico |               749 |           749 |                       50 |                0
--   atencao |             2.413 |         1.000 |                       50 |                5
--   estavel |            16.738 |         1.000 |                       50 |                2
--
-- Os 5 e 2 ZERADOS são o defeito de money-path: o cliente TEM compra, o teto comeu todas as
-- linhas dele, e o denominador (`usuariosAmostrados.length` = 50) o contava como "não
-- comprou". Isso é fabricar zero — `docs/agent/money-path.md` §2 ("ausente ≠ zero"). Em
-- `estavel` a edge via 6% das linhas e 30% dos produtos.
--
-- O QUE ESTA FUNÇÃO MUDA, e por que cada escolha (todas MEDIDAS, não estimadas):
--
-- · RECORTE = HISTÓRICO INTEIRO, sem janela temporal. Uma janela de 12 meses derrubaria
--   `critico` de 406 → 33 pares (−92%): `critico` É o cluster de quem parou de comprar, então
--   o `health_class` já codifica recência e filtrar por recência de novo é redundante E
--   destrutivo. (Medido: 44% dos pares de SKU ativo em `critico` têm mais de 36 meses, contra
--   15% em `estavel` — a assimetria é o próprio eixo do cluster.) "Últimos K pedidos" também
--   foi medido e descartado: jogaria fora 85% do sinal em `estavel` (4.172 → 628 pares).
--
-- · AMOSTRA ELIMINADA. A população elegível é PEQUENA — 779 / 348 / 100 clientes. Não há
--   cauda longa a amostrar: o cluster inteiro custa 51,9 ms (EXPLAIN ANALYZE no pior caso,
--   `critico`). Some junto a auto-inclusão, que era 1/50 = 2% de viés e passa a 0,13% / 0,29%
--   / 1,00% por diluição — sem precisar de leave-one-out.
--
-- · UNIVERSO DE PEDIDOS espelhado VERBATIM de `get_customer_sales_summary` (a RPC que alimenta
--   `sales_history_status`, que é o filtro do cluster): `status NOT IN
--   ('cancelado','rascunho','pendente','orcamento') AND deleted_at IS NULL`. O código anterior
--   contava linha de pedido CANCELADO no numerador enquanto o filtro do cluster já não a
--   contava — as duas metades da mesma pergunta discordavam.
--
-- · SKU ATIVO. 40–52% dos pares são de produto hoje inativo, que o consumidor JÁ descarta
--   (`carregarInsumos` lê `omie_products WHERE ativo`). Agregá-los é payload puro, não sinal.
--
-- · RETORNO EM UMA LINHA (jsonb), não linha-por-produto. Esta é a armadilha que quase reabriu
--   o defeito: o agregado tem 957 / 1.312 / 1.109 produtos, e o PostgREST capa em 1.000 EM
--   SILÊNCIO — INCLUSIVE em `.rpc()` (CLAUDE.md). Linha-por-produto truncaria DOIS dos três
--   clusters hoje, e `critico` está a 4% do teto. Uma linha não tem cap, é atômica (sem
--   página inconsistente) e pesa 40–55 kB. O nº de produtos é limitado ESTRUTURALMENTE pelo
--   catálogo ativo (3.140), então este eixo não cresce sem limite — o de clientes sim, e é lá
--   que mora o disjuntor.
--
-- · DENOMINADOR = POPULAÇÃO ELEGÍVEL, não "observados". Os dois DIVERGEM (779 vs 633 em
--   `critico`; 348 vs 334 em `atencao`) e a escolha MUDA comportamento: com população, zero
--   produtos cruzam 0,10 em `critico`; com observados, dois cruzam. População é o certo por
--   duas razões: (a) a leitura é EXAUSTIVA, então cliente sem par é fato OBSERVADO ("li o
--   histórico inteiro dele e X não está lá"), não truncagem — é precisamente a exaustividade
--   que separa este zero legítimo do zero fabricado que a função conserta; (b) "clientes
--   similares" no texto que o vendedor lê é a população do cluster, não a subpopulação que já
--   comprou algo — dividir pelos observados é viés de seleção (o denominador filtrado pelo
--   numerador) e infla `sim` sistematicamente.
--   ⚠️ (a) tem PRECONDIÇÃO: só vale enquanto o recorte for exaustivo. Se o disjuntor morder, o
--   denominador-população deixa de ser honesto — por isso `truncado` existe e por isso os
--   campos medidos voltam NULL, não zero.
--
-- Migration MANUAL: o Lovable NÃO aplica `supabase/migrations/` de nome custom. Mergear este
-- PR não toca o banco — alguém cola no SQL Editor e roda.
-- ============================================================

CREATE OR REPLACE FUNCTION public.recommend_cluster_agregado(
  p_health_class  text,
  p_teto_clientes integer DEFAULT 5000
)
RETURNS TABLE (
  denominador integer,
  observados  integer,
  produtos    jsonb,
  truncado    boolean
)
LANGUAGE sql
STABLE
-- SECURITY INVOKER (o default, explícito porque a escolha é deliberada): a edge `recommend`
-- é staff-only e chama com `service_role`, que já bypassa RLS. DEFINER criaria um bypass NOVO
-- sem comprar nada, e esta função devolve agregado de compras CROSS-CUSTOMER.
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
WITH eleg AS (
  -- Whitelist POSITIVA, espelho de CLUSTER_STATUS_COM_HISTORICO no edge. Não use
  -- `<> 'sem_historico'`: a coluna é NULLABLE e negação em SQL é NULL-blind, então o NULL
  -- sairia por efeito colateral invisível — e um status NOVO que signifique "sem venda"
  -- entraria SOZINHO. Whitelist falha FECHADA.
  SELECT s.customer_user_id
  FROM public.farmer_client_scores s
  WHERE s.health_class = p_health_class
    AND s.sales_history_status IN ('ativo', 'stale')
),
pop AS (SELECT count(*)::int AS n FROM eleg),
pares AS (
  -- DEDUP `(cliente, produto)`: o numerador conta clientes DISTINTOS, então recompra do mesmo
  -- SKU e pedido com muitos itens não podem pesar. Era exatamente o que gastava o teto de
  -- 1.000 sem acrescentar nada ao numerador.
  SELECT DISTINCT i.customer_user_id, i.product_id
  FROM public.order_items i
  JOIN public.sales_orders so ON so.id = i.sales_order_id
  JOIN public.omie_products o ON o.id = i.product_id
  WHERE i.customer_user_id IN (SELECT customer_user_id FROM eleg)
    -- Espelho VERBATIM de get_customer_sales_summary (o universo que define o filtro acima).
    AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
    AND so.deleted_at IS NULL
    AND o.ativo
    -- DISJUNTOR: acima do teto a função não faz o trabalho pesado e não devolve número.
    AND (SELECT n FROM pop) <= p_teto_clientes
),
agg AS (
  SELECT p.product_id, count(*)::int AS n
  FROM pares p
  GROUP BY p.product_id
)
SELECT
  (SELECT n FROM pop)                                                    AS denominador,
  -- Truncado ⇒ NULL, não 0. Zero aqui seria "medi e ninguém comprou"; NULL é "não medi" — a
  -- distinção inteira desta entrega.
  CASE WHEN (SELECT n FROM pop) > p_teto_clientes THEN NULL
       ELSE (SELECT count(DISTINCT p.customer_user_id)::int FROM pares p) END AS observados,
  CASE WHEN (SELECT n FROM pop) > p_teto_clientes THEN NULL
       ELSE COALESCE((SELECT jsonb_object_agg(a.product_id, a.n) FROM agg a), '{}'::jsonb) END AS produtos,
  (SELECT n FROM pop) > p_teto_clientes                                  AS truncado
$$;

-- `REVOKE FROM PUBLIC` NÃO tira `anon`/`authenticated` — eles têm grant explícito no Supabase
-- e precisam ser revogados POR NOME (CLAUDE.md). Sem isto, qualquer customer logado leria o
-- agregado de compras do cluster inteiro pelo Data API.
-- `CREATE OR REPLACE` preserva o ACL, mas o REVOKE é reemitido de propósito: um
-- `DROP FUNCTION` + `CREATE` futuro RESETA o ACL, e re-rodar esta migration é o conserto.
REVOKE ALL ON FUNCTION public.recommend_cluster_agregado(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recommend_cluster_agregado(text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.recommend_cluster_agregado(text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recommend_cluster_agregado(text, integer) TO service_role;

COMMENT ON FUNCTION public.recommend_cluster_agregado(text, integer) IS
  'sim_score do motor de recomendação, agregado no banco. Substitui o teto plano de 1.000 '
  'linhas de order_items que zerava clientes reais (5 em atencao, 2 em estavel — medido '
  '2026-08-21). Histórico inteiro, universo de pedidos de get_customer_sales_summary, SKU '
  'ativo, dedup (cliente,produto). Denominador = população elegível. truncado=true ⇒ '
  'observados/produtos vêm NULL e o consumidor trata sim como INDISPONÍVEL.';
