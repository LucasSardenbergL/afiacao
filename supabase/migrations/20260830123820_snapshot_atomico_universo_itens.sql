-- Snapshot CONSISTENTE do universo de itens+pedido para os dois consumidores money-path que hoje
-- paginam por keyset e sofrem a CESTA RASGADA.
--
-- O DEFEITO QUE ISTO FECHA. A leitura paginada casa pai e filho POR LINHA (`sales_orders!inner`),
-- mas não dá consistência do PEDIDO ao longo das páginas: irmãos do mesmo pedido têm uuid v4
-- espalhado, caem em páginas diferentes, e cada página é uma transação distinta. Se o pai vira
-- `cancelado` (ou é soft/hard-deletado) depois da 1ª página, os irmãos já lidos FICAM no acumulado
-- e os posteriores são eliminados pelo filtro — sai MEIO PEDIDO, sem exceção, com todos os ids
-- crescentes. Medido em prod (2026-08-30): 16.713 dos 31.114 pedidos têm mais de um item, ou seja
-- MAIS DA METADE do universo é exposta. Não existe instante em que essa cesta parcial seja
-- verdadeira: é perda de PRECISÃO (money-path §1), não o "recall recente" que foi avaliado e aceito.
--
-- ⚠️ O QUE ISTO **NÃO** DÁ — leia antes de chamar isto de "snapshot atômico do pedido". A garantia
-- aqui é de LEITURA: tudo que volta pertence a UM instante do banco. Isso NÃO é o mesmo que uma
-- revisão logicamente completa do pedido, porque o writer não é atômico: `sync-reprocess` reparte
-- a reconciliação de um pedido em VÁRIAS transações (insere/atualiza itens numa, remove os velhos
-- noutra, atualiza o cabeçalho depois). Existe portanto um instante REAL e commitado em que o
-- pedido está meio-reconciliado — e este snapshot vai lê-lo corretamente, porque ele existiu. A
-- diferença é essencial: a cesta rasgada era um estado que NUNCA existiu (artefato da paginação);
-- o estado intermediário do writer EXISTIU. Fechar o segundo exige atomizar a ESCRITA (RPC de
-- escrita por pedido, ou `order_revision` imutável com troca de ponteiro no fim) — escopo próprio,
-- registrado como pendência ABERTA em `docs/historico/paginacao-offset-janela.md`.
-- (Achado do challenge Codex gpt-5.6-sol/xhigh sobre esta entrega.)
--
-- ⚠️ POR QUE UMA ÚNICA QUERY, E NÃO "porque a função é STABLE". Uma função STABLE de fato executa
-- suas sub-queries no snapshot da query chamadora — mas fazer a CONSISTÊNCIA depender disso seria
-- pendurá-la num QUALIFICADOR, e este repo já foi mordido exatamente por aí: `CREATE OR REPLACE`
-- que omite `WITH (security_invoker=on)` RESETA a opção em silêncio (CLAUDE.md → armadilhas). Um
-- replace futuro que esqueça o `STABLE` devolve a função para VOLATILE — o default — e a garantia
-- cai SEM ERRO NENHUM, que é a pior falha possível no caminho do dinheiro.
--
-- Por isso: **exatamente uma query toca as tabelas**. Tudo abaixo dela (contagem, medição de
-- tamanho, tetos) opera sobre o `jsonb` já materializado em memória. Uma statement enxerga UM
-- snapshot MVCC, sempre, em qualquer nível de isolamento — pai e filhos, e todos os pedidos entre
-- si, vêm do MESMO instante por CONSTRUÇÃO. `STABLE` segue declarado porque é a verdade sobre a
-- função e ajuda o planejador; ele não é o que sustenta a garantia. (Provado: `db/test-snapshot-
-- universo-itens.sh` roda a função real marcada VOLATILE e exige que o resultado siga correto.)
--
-- POR QUE NÃO PAGINAR A MATERIALIZAÇÃO. O universo INTEIRO cabe numa resposta. MEDIDO em prod
-- 2026-08-30, com a forma EXATA que cada função devolve (não com uma forma parecida — a primeira
-- medição desta entrega errou por aí, agregando cestas em vez de itens, e subestimou 3,7x):
--   · Apriori  — 10.501.344 bytes (10,5 MB), 68.692 itens, 752 ms server-side.
--   · cockpit  —  6.345.896 bytes (6,3 MB), 14.628 itens na janela TTM.
-- Contra 256 MB de heap da Edge Function e um `statement_timeout` de no máximo 60 s no Data API
-- da Supabase, a folga é de ~25x em memória e ~80x em tempo. E o tráfego não cresce: hoje as
-- mesmas linhas já vêm, fatiadas em 69 e 17 páginas. Paginar uma materialização exigiria tabela
-- real + `snapshot_id` + GC, isto é, ESCRITA a cada leitura, para reconquistar uma consistência
-- que a query única já dá de graça. O PostgREST capa cada resposta em 1.000 LINHAS, inclusive
-- `.rpc()` — e estas devolvem UMA linha.
-- ⚠️ O tamanho máximo de RESPOSTA do gateway da Supabase não é documentado publicamente. Por isso
-- os tetos abaixo são conservadores e o payload é medido, não estimado.
--
-- FORMA DA RESPOSTA. O Apriori sairia em 5.629.734 bytes (-46%) se a RPC devolvesse CESTAS já
-- agrupadas por pedido em vez de um objeto por item. Fica deliberadamente de fora: agrupar mudaria
-- `agruparCestasPorSegmento` — helper com suíte própria, que também conta as linhas DESCARTADAS —
-- e esta entrega é de TRANSPORTE, não de semântica. O número fica registrado para quem precisar.

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- OS DOIS FUSÍVEIS, E POR QUE NENHUM DELES É CONFIGURÁVEL PELO CHAMADOR
-- ────────────────────────────────────────────────────────────────────────────────────────────
-- `p_teto_*` existe para o TESTE poder apertar o fusível, nunca para o chamador AFROUXÁ-LO: os
-- dois passam por `least(...)` contra um máximo interno. Um limite de segurança que se contorna
-- passando um número maior não é limite (achado do challenge Codex).
--
--   · CARDINALIDADE (`LIMIT n+1`) — é o fusível que protege o BACKEND, porque age ANTES do
--     `jsonb_agg`: o Postgres nunca constrói mais que `n+1` linhas. O `+1` é o que separa
--     "couberam exatamente n" de "havia mais" — sem ele, `n` linhas seriam indistinguíveis de
--     truncagem, que é o defeito do cap de 1.000 do PostgREST por outra porta.
--   · BYTES — é o fusível do TRANSPORTE (gateway + heap da edge), e por definição só pode ser
--     medido depois de construir. Medir antes exigiria uma segunda query, e uma segunda query
--     devolveria a consistência às mãos do qualificador `STABLE`, que é o que este desenho recusa.
--
-- Os dois LANÇAM. Truncagem silenciosa é o pecado que este repo persegue: devolver "quase tudo"
-- com cara de tudo é pior que não devolver nada, porque o consumidor publica em cima.

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 1) Universo do Apriori (`omie-analytics-sync`)
-- ────────────────────────────────────────────────────────────────────────────────────────────
-- O resultado vira REGRA DE ASSOCIAÇÃO publicada globalmente: uma cesta partida não some de uma
-- tela, vira uma regra que ninguém consegue explicar depois.
CREATE OR REPLACE FUNCTION public.apriori_universo_snapshot(
  p_status_nao_venda text[],
  p_teto_linhas integer DEFAULT 250000,
  p_teto_bytes  bigint  DEFAULT 25165824   -- 24 MiB
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  -- Espelho da autoridade `STATUS_NAO_VENDA` (TS `_shared/universo-pedidos.ts`, que por sua vez
  -- espelha o corpo em prod de `private.margem_cliente_agregada()`).
  c_canonico  constant text[] := ARRAY['cancelado','rascunho','pendente','orcamento'];
  c_max_linhas constant integer := 500000;
  c_max_bytes  constant bigint  := 33554432;  -- 32 MiB — o máximo ABSOLUTO, não contornável
  v_teto_linhas integer := least(coalesce(p_teto_linhas, 0), c_max_linhas);
  v_teto_bytes  bigint  := least(coalesce(p_teto_bytes, 0), c_max_bytes);
  v_itens jsonb;
  v_bytes bigint;
BEGIN
  -- FAIL-CLOSED na denylist. Não basta "não-vazia e sem NULL": uma lista que OMITA `cancelado`
  -- passaria nessas duas checagens e produziria um universo semanticamente inválido — pedido
  -- cancelado virando venda — sem erro nenhum (achado do challenge Codex). A função exige
  -- IGUALDADE DE CONJUNTO com a lista canônica, ignorando ordem e repetição. Isso transforma a
  -- paridade TS↔SQL, que hoje é um guard de teste, em invariante EXECUTÁVEL no banco: divergiu,
  -- a leitura para — que é o desfecho certo quando a alternativa é publicar regra errada.
  IF p_status_nao_venda IS NULL
     OR (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_status_nao_venda) x) IS DISTINCT FROM
        (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(c_canonico) x)
  THEN
    RAISE EXCEPTION 'apriori_universo_snapshot: denylist de status divergente da canônica (recebido %, esperado %) — publicar o universo com outra denylist é publicar regra de associação sobre pedido que não é venda', p_status_nao_venda, c_canonico
      USING ERRCODE = '22023';
  END IF;
  IF v_teto_linhas <= 0 OR v_teto_bytes <= 0 THEN
    RAISE EXCEPTION 'apriori_universo_snapshot: teto inválido (linhas=%, bytes=%)', v_teto_linhas, v_teto_bytes
      USING ERRCODE = '22023';
  END IF;

  -- ═══ A ÚNICA QUERY QUE TOCA AS TABELAS ═══════════════════════════════════════════════════
  -- Um snapshot MVCC. O JOIN interno é o que era o `sales_orders!inner`; os filtros de universo
  -- (produto vinculado, não-apagado, status de venda) são os mesmos do call-site de hoje.
  -- `ORDER BY` dentro do agregado: o Apriori é reprodutível só se a ordem de entrada for estável.
  -- `oi.id` desempata e NÃO é projetado — ele existia no `.select()` só porque o cursor do keyset
  -- precisava dele, e o cursor morreu aqui.
  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'sales_order_id', t.sales_order_id,
               'product_id',     t.product_id,
               'sales_orders',   jsonb_build_object('account', t.account)
             )
             ORDER BY t.sales_order_id, t.product_id, t.id
           ),
           '[]'::jsonb
         )
    INTO v_itens
  FROM (
    SELECT oi.id, oi.sales_order_id, oi.product_id, so.account
    FROM public.order_items oi
    JOIN public.sales_orders so ON so.id = oi.sales_order_id
    WHERE oi.product_id IS NOT NULL
      AND so.deleted_at IS NULL
      AND so.status <> ALL (p_status_nao_venda)
    ORDER BY oi.id
    LIMIT v_teto_linhas + 1
  ) t;
  -- ═════════════════════════════════════════════════════════════════════════════════════════

  -- Daqui para baixo NADA lê tabela: é computação sobre o valor já materializado.
  IF jsonb_array_length(v_itens) > v_teto_linhas THEN
    RAISE EXCEPTION 'apriori_universo_snapshot: universo excede o teto de % linhas — aumente o teto DEPOIS de conferir o heap da edge, ou volte a paginar COM snapshot', v_teto_linhas
      USING ERRCODE = '54000';
  END IF;
  v_bytes := octet_length(v_itens::text);
  IF v_bytes > v_teto_bytes THEN
    RAISE EXCEPTION 'apriori_universo_snapshot: universo com % bytes excede o teto de % bytes — aumente o teto DEPOIS de conferir o heap da edge, ou volte a paginar COM snapshot', v_bytes, v_teto_bytes
      USING ERRCODE = '54000';
  END IF;

  RETURN jsonb_build_object(
    'total',       jsonb_array_length(v_itens),
    'bytes_itens', v_bytes,
    'itens',       v_itens
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.apriori_universo_snapshot(text[], integer, bigint) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apriori_universo_snapshot(text[], integer, bigint) TO service_role;

COMMENT ON FUNCTION public.apriori_universo_snapshot(text[], integer, bigint) IS
  'Universo do Apriori num snapshot CONSISTENTE de leitura (uma única query = um snapshot MVCC), fechando a CESTA RASGADA da leitura paginada. NÃO garante revisão logicamente completa do pedido — o writer não é atômico (ver cabeçalho da migration). Fail-closed: denylist divergente e estouro de teto LANÇAM, nunca truncam.';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- 2) Itens do cockpit de valor (`fin-valor-cockpit`)
-- ────────────────────────────────────────────────────────────────────────────────────────────
-- Receita parcial de um pedido vira margem e EVP errados. Aqui NÃO há filtro de status: a régua de
-- faturabilidade (`pedidoContaNoFaturamento`) e a janela por `order_date_kpi` são aplicadas no
-- consumidor, sobre o pai que vem junto — contrato mantido de propósito, para a mudança ser de
-- TRANSPORTE e não de regra de negócio.
CREATE OR REPLACE FUNCTION public.cockpit_itens_snapshot(
  p_created_at_de timestamptz,
  p_teto_linhas integer DEFAULT 150000,
  p_teto_bytes  bigint  DEFAULT 25165824
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
  c_max_linhas constant integer := 500000;
  c_max_bytes  constant bigint  := 33554432;
  v_teto_linhas integer := least(coalesce(p_teto_linhas, 0), c_max_linhas);
  v_teto_bytes  bigint  := least(coalesce(p_teto_bytes, 0), c_max_bytes);
  v_itens jsonb;
  v_bytes bigint;
BEGIN
  -- Sem prefiltro de carga a leitura viraria a tabela INTEIRA (70.531 linhas contra 14.628 na
  -- janela medida) — degradar para "tudo" é o oposto de fail-closed.
  IF p_created_at_de IS NULL THEN
    RAISE EXCEPTION 'cockpit_itens_snapshot: `p_created_at_de` ausente — sem o prefiltro de carga a leitura viraria a tabela inteira'
      USING ERRCODE = '22023';
  END IF;
  IF v_teto_linhas <= 0 OR v_teto_bytes <= 0 THEN
    RAISE EXCEPTION 'cockpit_itens_snapshot: teto inválido (linhas=%, bytes=%)', v_teto_linhas, v_teto_bytes
      USING ERRCODE = '22023';
  END IF;

  -- ═══ A ÚNICA QUERY QUE TOCA AS TABELAS ═══════════════════════════════════════════════════
  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'customer_user_id',    t.customer_user_id,
               'product_id',          t.product_id,
               'omie_codigo_produto', t.omie_codigo_produto,
               'quantity',            t.quantity,
               'unit_price',          t.unit_price,
               'discount',            t.discount,
               'sales_order_id',      t.sales_order_id,
               'sales_orders', jsonb_build_object(
                 'status',         t.status,
                 'deleted_at',     t.deleted_at,
                 'order_date_kpi', t.order_date_kpi,
                 'account',        t.account,
                 'origem',         t.origem,
                 'checkout_id',    t.checkout_id
               )
             )
             ORDER BY t.id
           ),
           '[]'::jsonb
         )
    INTO v_itens
  FROM (
    SELECT oi.id, oi.customer_user_id, oi.product_id, oi.omie_codigo_produto, oi.quantity,
           oi.unit_price, oi.discount, oi.sales_order_id,
           so.status, so.deleted_at, so.order_date_kpi, so.account, so.origem, so.checkout_id
    FROM public.order_items oi
    JOIN public.sales_orders so ON so.id = oi.sales_order_id
    WHERE oi.created_at >= p_created_at_de
    ORDER BY oi.id
    LIMIT v_teto_linhas + 1
  ) t;
  -- ═════════════════════════════════════════════════════════════════════════════════════════

  IF jsonb_array_length(v_itens) > v_teto_linhas THEN
    RAISE EXCEPTION 'cockpit_itens_snapshot: universo excede o teto de % linhas — aumente o teto DEPOIS de conferir o heap da edge, ou estreite a janela de carga', v_teto_linhas
      USING ERRCODE = '54000';
  END IF;
  v_bytes := octet_length(v_itens::text);
  IF v_bytes > v_teto_bytes THEN
    RAISE EXCEPTION 'cockpit_itens_snapshot: universo com % bytes excede o teto de % bytes — aumente o teto DEPOIS de conferir o heap da edge, ou estreite a janela de carga', v_bytes, v_teto_bytes
      USING ERRCODE = '54000';
  END IF;

  RETURN jsonb_build_object(
    'total',       jsonb_array_length(v_itens),
    'bytes_itens', v_bytes,
    'itens',       v_itens
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cockpit_itens_snapshot(timestamptz, integer, bigint) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cockpit_itens_snapshot(timestamptz, integer, bigint) TO service_role;

COMMENT ON FUNCTION public.cockpit_itens_snapshot(timestamptz, integer, bigint) IS
  'Itens do cockpit de valor num snapshot CONSISTENTE de leitura (uma única query = um snapshot MVCC), fechando a CESTA RASGADA da leitura paginada. NÃO garante revisão logicamente completa do pedido — o writer não é atômico (ver cabeçalho da migration). Fail-closed: prefiltro ausente e estouro de teto LANÇAM, nunca truncam.';
