-- IDENTIDADE DE LINHA DO ITEM DO PEDIDO — a correção ESTRUTURAL do P1-1 que o #2134 nomeou e
-- deixou aberta ("Segue aberto" de docs/historico/atomicidade-logica-do-pedido.md).
--
-- ⚠️ MIGRATION MANUAL — Lovable NÃO auto-aplica nome custom. Colar no SQL Editor → Run.
-- Idempotente (ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION); re-colar é seguro.
-- Provada em PG17 local (db/test-reconciliar-pedidos-omie.sh) com falsificação.
--
-- ⚠️⚠️ ESTA MIGRATION EMPILHA SOBRE `20260905225613_preco_ausente_nao_e_zero.sql`, NÃO sobre a
-- `20260830190000`. O corpo abaixo foi DERIVADO do corpo vigente por transformação, e não
-- reescrito: a régua de preço (finitude não-negativa, ausente→NULL) e a comparação NULL-SAFE do
-- `upd` estão preservadas verbatim. Recriar a função a partir do corpo de 30/08 teria REVERTIDO
-- o #2224 em silêncio — "a última a recriar VENCE" (database.md §4), e num apply manual quem
-- vence é quem for colado por último, não quem tem o timestamp maior. **Pré-flight obrigatório
-- antes de colar:** `pg_get_functiondef` da PROD para conferir que o corpo lá ainda é o do
-- #2224; se tiver divergido, esta migration precisa ser re-derivada do corpo VIVO.
--
-- ── O DEFEITO ────────────────────────────────────────────────────────────────────────────────
-- `omie_codigo_produto` NÃO é identidade de linha. Com o mesmo SKU em duas linhas do pedido não
-- há como dizer qual linha local casa com qual item do payload — e o #2134, sem ter identidade
-- para oferecer, fez a única coisa honesta: PULOU o pedido inteiro (nem itens, nem cabeçalho).
-- Degradação, não conserto. Esta migration traz a identidade que faltava: `det.ide.codigo_item`,
-- o ID do item que o próprio Omie atribui ("preenchimento automático", doc oficial do endpoint
-- produtos/pedido/).
--
-- ── MEDIDO EM PROD (psql-ro, 2026-08-30) — e a medição MUDOU o desenho ───────────────────────
-- 1.179 pares `(sales_order_id, omie_codigo_produto)` repetidos, em 1.049 pedidos Omie vivos.
-- A pergunta que decide o que fazer com eles é se a duplicidade é LEGÍTIMA ou lixo de import.
-- Medido contra o retrato do próprio payload (`sales_orders.items`): em **1.177 dos 1.179 pares
-- o Omie repete o SKU também**, e 1.057 (90%) têm quantidade/preço DIFERENTES entre as linhas.
-- É legítima — dois lançamentos do mesmo produto no pedido. Deduplicar destruiria dado real, e
-- é por isso que `order_items` não pode ganhar unique em (pedido, SKU) (database.md §5).
--
-- ── POR QUE NÃO HÁ BACKFILL DAS ~70 MIL LINHAS ───────────────────────────────────────────────
-- Era o caminho esperado, e a medição o dispensa. Três fatos, nesta ordem:
--   1. **Zero foreign keys apontam para `order_items`** (medido no catálogo de prod). Nada lá
--      fora guarda o `id` de um item, então recriar linha não deixa referência pendurada.
--   2. Identidade de linha só é USADA no instante da reconciliação — e é exatamente esse o
--      instante em que o payload a fornece. Linha que nunca reconcilia nunca precisa dela.
--   3. A janela do reprocess é de 7 dias (operacional) / 30 (estratégica). Dos 1.049 pedidos
--      ambíguos, **7 estão dentro de 7 dias e 14 dentro de 30**; o resto vai até 2020-04-17.
--      Os outros 1.035 não estavam congelados PELO GUARD — estão fora de qualquer janela há
--      anos, e continuariam fora com ou sem esta entrega.
-- ⇒ A adoção da identidade acontece sozinha, incrementalmente, pela própria reconciliação: para
--    pedido com SKU único (97% da janela) o SKU JÁ É identidade naquele pedido, então o
--    casamento de nível 2 é correto por construção e o `UPDATE` grava o `codigo_item` de graça.
--
-- ── O QUE ESTA MIGRATION NÃO PROMETE ─────────────────────────────────────────────────────────
-- Que o `ListarPedidos` devolve `det.ide.codigo_item`. A doc oficial diz que a resposta é um
-- array do tipo `pedido_venda_produto`, que contém `det.ide.codigo_item` — mas a MESMA página
-- documenta `infoCadastro.dAlt/hAlt`, que o #2134 não conseguiu provar que chegam. Nesta API,
-- documentação não é medição, e não existe payload de `ListarPedidos` persistido em lugar nenhum
-- (192 linhas em `omie_webhook_events`, ZERO com `det` ou `codigo_item`). Por isso o desenho é
-- INERTE-ATÉ-ALIMENTADO: sem o campo, toda linha fica com `omie_codigo_item` nulo, o caminho de
-- identidade nunca liga, e o comportamento é byte-a-byte o de hoje. A coluna É o sensor — o
-- contador `identidade_adotada` do retorno e o `itens_com_codigo_item/itens_lidos` que a edge
-- registra em `metadata` respondem a pergunta COM DENOMINADOR na primeira run.
--
-- ── A ARMADILHA QUE JÁ FOI PAGA UMA VEZ, E QUE AQUI TEM CHAVE NOVA ───────────────────────────
-- Um guard de ambiguidade tem DOIS lados — o payload que chega e o estado que já está gravado —
-- e o lado esquecido costuma ser o do BANCO (foi exatamente esse o P1-1 do parecer). A chave
-- muda, a armadilha não: por isso são DOIS guards de `omie_codigo_item` repetido, um em cada
-- lado (`G-a` no desejado, `G-b` no atual), e nenhum deles substitui o outro.

BEGIN;

-- ── 1. A coluna ──────────────────────────────────────────────────────────────────────────────
-- Sem UNIQUE de propósito. A distinção é garantida pelos guards da RPC (que PULAM o pedido, o
-- desfecho honesto), não por constraint: uma violação viraria 23xxx capturada pela allowlist e
-- deixaria o pedido quebrado para sempre por uma esquisitice da origem. Sem índice também: todo
-- acesso é `WHERE sales_order_id = ?`, que já tem índice — a coluna é lida junto da linha.
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS omie_codigo_item bigint;

COMMENT ON COLUMN public.order_items.omie_codigo_item IS
  'IDENTIDADE DE LINHA do item dentro do pedido Omie (`det.ide.codigo_item`, atribuído pelo Omie). '
  'NULL = linha ainda sem identidade (pré-existente, ou origem que não a forneceu) — a reconciliação '
  'degrada para casamento por omie_codigo_produto, que só é identidade quando o SKU não se repete no pedido. '
  'NÃO tem UNIQUE: a distinção é guardada na RPC reconciliar_pedidos_omie (pedido ambíguo é PULADO, não corrigido).';

-- ── 2. A RPC, com casamento em dois níveis ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reconciliar_pedidos_omie(p_pedidos jsonb, p_status_gerido_omie text[], p_lido_em timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  -- Espelho da autoridade `STATUS_OMIE` (TS `_shared/omie-pedido.ts`): os status cujo dono é o
  -- Omie. Status app-avançado (`confirmado`, `entregue`, ...) NÃO está aqui de propósito — quem
  -- reconcilia por cima dele apaga trabalho humano.
  c_status_omie  constant text[] := ARRAY['importado','separacao','enviado','faturado','cancelado'];
  -- Teto do LOTE. A página do ListarPedidos é de 100; 500 é folga. NÃO é parâmetro: um limite que
  -- o chamador contorna passando um número maior não é limite (achado do challenge do #2132).
  c_max_pedidos  constant integer := 500;

  v_pedido        jsonb;
  v_account       text;
  v_hash          text;
  v_status_omie   text;
  v_itens         jsonb;
  v_items_json    jsonb;
  v_total_novo    numeric;

  v_order_id      uuid;
  v_customer      uuid;
  v_status_atual  text;
  v_total_atual   numeric;
  v_status_novo   text;

  v_n_validos     integer;
  v_n_distintos   integer;
  v_n_id_desej    integer;   -- itens do DESEJADO que trazem omie_codigo_item
  v_n_id_desej_d  integer;   -- ...quantos valores DISTINTOS
  v_atual_dup     integer;
  v_atual_id_dup  integer;   -- linhas ATUAIS com omie_codigo_item repetido (o lado do BANCO)
  v_ident         boolean;   -- este pedido pode ser diffado por IDENTIDADE DE LINHA
  v_items_atual   jsonb;
  v_subtotal_atual numeric;
  v_lido_atual    timestamptz;
  v_cab_mudou     boolean;
  v_stale         integer := 0;
  v_ambiguo       integer := 0;
  v_del int; v_upd int; v_ins int; v_adot int;
  v_itens_mudaram boolean;
  v_status_mudou  boolean;
  v_total_mudou   boolean;

  v_upserts       integer := 0;
  v_divergences   integer := 0;
  v_corrections   integer := 0;
  v_sku_repetido  integer := 0;
  v_sem_item      integer := 0;
  v_sem_pai       integer := 0;
  v_id_adotada    integer := 0;   -- linhas que GANHARAM omie_codigo_item nesta chamada (sensor)
  v_id_usada      integer := 0;   -- pedidos diffados por identidade de linha (sensor)
  v_falhas        jsonb   := '[]'::jsonb;
BEGIN
  IF p_pedidos IS NULL OR jsonb_typeof(p_pedidos) <> 'array' THEN
    RAISE EXCEPTION 'reconciliar_pedidos_omie: p_pedidos deve ser array jsonb (veio %)', jsonb_typeof(p_pedidos)
      USING ERRCODE = '22023';
  END IF;

  -- FAIL-CLOSED na lista de status geridos pelo Omie, ANTES do loop: se a lista divergiu, NENHUM
  -- pedido deve ser tocado. Não basta "não-vazia e sem NULL" — uma lista que ACRESCENTE
  -- `confirmado` faria a reconciliação rebaixar um pedido que o time já avançou à mão, e uma que
  -- OMITA `importado` congelaria pedidos legítimos em silêncio. Exigir IGUALDADE DE CONJUNTO
  -- promove a paridade TS↔SQL de guard de teste a invariante EXECUTÁVEL em produção — a mesma
  -- forma que `apriori_universo_snapshot` usa para a denylist de status (#2132).
  IF p_status_gerido_omie IS NULL
     OR (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_status_gerido_omie) x) IS DISTINCT FROM
        (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(c_status_omie) x)
  THEN
    RAISE EXCEPTION 'reconciliar_pedidos_omie: lista de status geridos pelo Omie divergente da canônica (recebido %, esperado %) — reconciliar status com outra lista é clobberar status app-avançado ou congelar pedido legítimo',
      p_status_gerido_omie, c_status_omie
      USING ERRCODE = '22023';
  END IF;

  -- Ausente ≠ "agora". Assumir `now()` faria toda chamada parecer a mais fresca de todas e
  -- desligaria o CAS em silêncio — a leitura velha voltaria a vencer.
  IF p_lido_em IS NULL THEN
    RAISE EXCEPTION 'reconciliar_pedidos_omie: p_lido_em ausente — sem o instante da leitura não há como barrar escrita de revisão VELHA'
      USING ERRCODE = '22023';
  END IF;
  -- Leitura no futuro é relógio torto do chamador, e um carimbo torto envenena o CAS de todos os
  -- runs seguintes (nenhum deles conseguiria mais escrever). Tolerância de 1 min para skew.
  IF p_lido_em > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'reconciliar_pedidos_omie: p_lido_em no futuro (% > %) — relógio do chamador envenenaria o compare-and-set', p_lido_em, now()
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_pedidos) > c_max_pedidos THEN
    RAISE EXCEPTION 'reconciliar_pedidos_omie: lote de % pedidos excede o teto de % — divida a chamada (truncar em silêncio seria pior)',
      jsonb_array_length(p_pedidos), c_max_pedidos
      USING ERRCODE = '54000';
  END IF;

  -- ⚠️ ORDEM DETERMINÍSTICA (achado do challenge). Uma chamada é UMA transação: os locks dos
  -- pedidos já processados ficam presos até o fim dela. Dois lotes contendo os mesmos pedidos em
  -- ordens diferentes — inclusive cruzando com `criar_pedidos_com_itens` — formam ciclo AB/BA e
  -- deadlockam. Ordenar por (account, hash_payload) faz toda chamada pegar os locks na MESMA
  -- ordem, o que torna o ciclo impossível em vez de improvável.
  FOR v_pedido IN
    SELECT e FROM jsonb_array_elements(p_pedidos) e
     ORDER BY e->>'account', e->>'hash_payload'
  LOOP
    -- ── subtransação por pedido (G9 da irmã): um pedido ruim não derruba os outros, e o que ele
    --    tiver escrito até o erro é DESFEITO — que é justamente a atomicidade lógica pedida aqui.
    --    Substitui o "grava itens primeiro, cabeçalho só se nenhum item falhou" que o TS fazia à
    --    mão, e que nunca cobriu a falha ENTRE dois writes de item. ──
    BEGIN
      v_order_id := NULL;
      v_del := 0; v_upd := 0; v_ins := 0; v_adot := 0;

      v_account     := v_pedido->>'account';
      v_hash        := v_pedido->>'hash_payload';
      v_status_omie := v_pedido->>'status_omie';   -- NULL = etapa desconhecida (o TS já decidiu)
      v_itens       := coalesce(v_pedido->'itens', '[]'::jsonb);
      v_items_json  := v_pedido->'items';

      IF v_account IS NULL OR v_hash IS NULL THEN
        RAISE EXCEPTION 'pedido sem account/hash_payload' USING ERRCODE = '22023';
      END IF;

      -- Ausente ≠ zero (money-path §2). `total` faltando NÃO vira 0: zerar o total de um pedido
      -- real é fabricar número no caminho da positivação/comissão. Idem `items`, cuja ausência
      -- não pode virar `[]` — isso APAGARIA o retrato do pedido no cabeçalho.
      IF (v_pedido->>'total') IS NULL THEN
        RAISE EXCEPTION 'pedido % sem total — ausente não é zero', v_hash USING ERRCODE = '22023';
      END IF;
      v_total_novo := (v_pedido->>'total')::numeric;
      IF v_items_json IS NULL OR jsonb_typeof(v_items_json) <> 'array' THEN
        RAISE EXCEPTION 'pedido % sem items (jsonb array) — ausente não é lista vazia', v_hash USING ERRCODE = '22023';
      END IF;
      IF v_status_omie IS NOT NULL AND NOT (v_status_omie = ANY (c_status_omie)) THEN
        RAISE EXCEPTION 'pedido % com status_omie desconhecido (%)', v_hash, v_status_omie USING ERRCODE = '22023';
      END IF;

      -- [A4/G7] guard de leitura vazia/malformada: sem item VÁLIDO o pedido NÃO é reconciliado —
      -- nem itens nem cabeçalho. Um ListarPedidos degenerado não pode zerar o total de um pedido
      -- real nem apagar seus itens.
      SELECT count(*),
             count(DISTINCT (it->>'omie_codigo_produto')::bigint),
             count(*) FILTER (WHERE (it->>'omie_codigo_item') IS NOT NULL),
             count(DISTINCT (it->>'omie_codigo_item')::bigint)
        INTO v_n_validos, v_n_distintos, v_n_id_desej, v_n_id_desej_d
        FROM jsonb_array_elements(v_itens) AS it
       WHERE (it->>'omie_codigo_produto') IS NOT NULL;
      IF v_n_validos = 0 THEN
        v_sem_item := v_sem_item + 1;
        CONTINUE;
      END IF;

      -- ── G-a: identidade repetida no DESEJADO. Dois itens do payload com o mesmo `codigo_item`
      --    é payload contraditório: a chave que existe para desempatar está empatada. Casar por
      --    ela produziria dois UPDATEs sobre a mesma linha local (ou um INSERT fantasma), e
      --    persistir o valor repetido envenenaria o estado — na run seguinte o `G-b` pararia o
      --    pedido para sempre. Fail-closed aqui, antes de qualquer escrita.
      IF v_n_id_desej > 0 AND v_n_id_desej_d <> v_n_id_desej THEN
        v_ambiguo := v_ambiguo + 1;
        CONTINUE;
      END IF;

      -- Identidade só vale quando é COMPLETA no desejado. Payload parcialmente identificado
      -- (item de kit, por exemplo, que a doc do Omie marca como podendo não trazer o código) cai
      -- no caminho legado INTEIRO: misturar duas chaves de casamento no mesmo pedido é convidar
      -- de volta a classe de defeito que esta função existe para fechar.
      v_ident := (v_n_id_desej = v_n_validos);

      -- Identidade IMUTÁVEL: o pai vem pelo hash determinístico (único pelo índice parcial
      -- uniq_sales_orders_omie_hash), NUNCA por omie_numero_pedido — pegaria a linha errada
      -- (causa-raiz #B). `FOR UPDATE` serializa contra `criar_pedidos_com_itens`, que trava o
      -- mesmo pai. Sem pai não há o que reconciliar: quem INSERE é o omie-vendas-sync.
      -- P1-3: `items`/`subtotal`/`omie_reconciliado_em` entram na leitura porque entram na DECISÃO.
      SELECT id, customer_user_id, status, total, items, subtotal, omie_reconciliado_em
        INTO v_order_id, v_customer, v_status_atual, v_total_atual,
             v_items_atual, v_subtotal_atual, v_lido_atual
        FROM public.sales_orders
       WHERE account = v_account AND hash_payload = v_hash
       FOR UPDATE;
      IF v_order_id IS NULL THEN
        v_sem_pai := v_sem_pai + 1;
        CONTINUE;
      END IF;

      -- ── P1-2: COMPARE-AND-SET. Uma leitura mais VELHA que a que produziu o estado atual não
      --    escreve. Sem isto, o `FOR UPDATE` garante que as escritas não se entrelaçam, mas não
      --    que a ÚLTIMA a chegar é a mais NOVA — e o banco fica atomicamente errado. `>=` e não
      --    `>`: duas páginas do MESMO run trazem o mesmo carimbo e a segunda não pode ser barrada,
      --    então o empate só é rejeitado quando nada mudaria de qualquer forma — por isso o
      --    empate PASSA e só o estritamente ANTERIOR é recusado.
      IF v_lido_atual IS NOT NULL AND p_lido_em < v_lido_atual THEN
        v_stale := v_stale + 1;
        CONTINUE;
      END IF;

      -- ── P1-1 (achado do challenge, MEDIDO em prod: 1.179 pares repetidos em 1.049 pedidos
      --    Omie vivos): `omie_codigo_produto` NÃO é identidade de linha, e a duplicidade tem DOIS
      --    lados. O guard antigo olhava só o conjunto desejado, e com isso:
      --      · duplicata no estado ATUAL caía toda no `UPDATE` (`d.cod = a.cod`), as duas linhas
      --        recebiam o MESMO conteúdo, nenhuma era deletada — e o cabeçalho passava a
      --        descrever UMA linha enquanto existiam duas. Apriori e cockpit DOBRAM o valor.
      --      · duplicata no DESEJADO pulava os itens mas reconciliava o cabeçalho — "filhos
      --        velhos + cabeçalho novo", que é a revisão MISTA que esta função existe para
      --        eliminar. O antigo assert C6 exigia esse comportamento: o teste protegia o defeito.
      --    Enquanto não houver identidade de linha persistida (`det.ide.codigo_item` — correção
      --    ESTRUTURAL, escopo próprio, exige backfill das ~70 mil linhas vivas), o desfecho certo
      --    é NÃO TOCAR NO PEDIDO: nem itens, nem cabeçalho. Precisão > recall — um pedido que
      --    fica na revisão anterior COMPLETA é honesto; um pedido com valor dobrado, não.
      -- ── G-b: identidade repetida no ATUAL — O LADO DO BANCO. Este é o lado que a versão
      --    anterior desta função esqueceu na chave antiga, e o motivo de o parecer ter BLOQUEADO
      --    a entrega. A chave mudou; a armadilha não. Duas linhas locais com o mesmo
      --    `codigo_item` casariam AMBAS com o mesmo item desejado no nível 1: as duas recebem o
      --    conteúdo dele, nenhuma é deletada, e o item que ficou sem par é inserido por cima — o
      --    pós-estado deixa de ser o desejado. Vale SEMPRE, inclusive no caminho legado, porque o
      --    ESTADO pode carregar identidade mesmo quando o payload de hoje não traz.
      SELECT count(*) INTO v_atual_id_dup FROM (
        SELECT 1 FROM public.order_items
         WHERE sales_order_id = v_order_id AND omie_codigo_item IS NOT NULL
         GROUP BY omie_codigo_item HAVING count(*) > 1
      ) d;
      IF v_atual_id_dup > 0 THEN
        v_ambiguo := v_ambiguo + 1;
        CONTINUE;
      END IF;

      -- ── G-c: sem identidade completa, a chave de casamento volta a ser o SKU — e aí valem os
      --    DOIS lados do guard, inalterados. `omie_codigo_produto` só é identidade quando não se
      --    repete no pedido; quando repete (1.179 pares medidos em prod, e a duplicidade é
      --    LEGÍTIMA: o payload do Omie repete o SKU em 1.177 deles), não há como dizer qual linha
      --    casa com qual item.
      --    ⚠️ Este guard NÃO é mais o que impede o valor DOBRADO — isso passou a ser estrutural,
      --    no requisito de 1-1 entre os remanescentes do nível 2 abaixo. O que ele impede agora é
      --    o pedido ambíguo ser RECONSTRUÍDO a cada run: sem identidade de linha o casamento
      --    nunca converge, então o delete+insert se repetiria a cada 2 h com `corrections`
      --    inflado para sempre. Congelar é estável; reconstruir em loop, não.
      IF NOT v_ident THEN
        SELECT count(*) INTO v_atual_dup FROM (
          SELECT 1 FROM public.order_items
           WHERE sales_order_id = v_order_id AND omie_codigo_produto IS NOT NULL
           GROUP BY omie_codigo_produto HAVING count(*) > 1
        ) d;
        IF v_n_distintos <> v_n_validos OR v_atual_dup > 0 THEN
          v_ambiguo := v_ambiguo + 1;
          IF v_n_distintos <> v_n_validos THEN
            v_sku_repetido := v_sku_repetido + 1;
          END IF;
          CONTINUE;
        END IF;
      ELSE
        v_id_usada := v_id_usada + 1;
      END IF;

      BEGIN
        -- ── A reconciliação INTEIRA numa única statement. As CTEs de escrita enxergam o MESMO
        --    snapshot inicial; os três conjuntos (remover / atualizar / inserir) são disjuntos
        --    por construção, porque `par` é um casamento 1-1 provado pelos guards acima.
        --
        --    O casamento tem DOIS NÍVEIS, e o nível 2 é o que dispensa o backfill:
        --      · nível 1 — por `omie_codigo_item`, quando os dois lados o têm;
        --      · nível 2 — por `omie_codigo_produto`, e SÓ onde o SKU é 1-1 entre os que
        --        SOBRARAM, nos DOIS lados. É aqui que a linha antiga (sem identidade) casa com o
        --        item novo (com identidade) e o `UPDATE` GRAVA o `codigo_item`: a adoção é
        --        incremental, correta por construção (SKU único naquele pedido É identidade
        --        naquele pedido) e preserva o `id` da linha.
        --    O caminho legado é um CASO PARTICULAR disto, não um ramo à parte: com `v_ident`
        --    falso o nível 1 é vazio, e o `G-c` já garantiu SKU 1-1 dos dois lados, então o
        --    nível 2 reproduz exatamente o join `d.cod = a.cod` de antes. Um `IF/ELSE` com duas
        --    statements teria o mesmo efeito e DUAS superfícies para divergir.
        --
        --    O que sobra de `atual` é DELETE; o que sobra de `desejado` é INSERT. O pós-estado é
        --    exatamente o conjunto desejado — essa é a invariante, e é ela que o harness afirma.
        --    Tolerância de 1e-6 preservada, e a comparação de preço segue NULL-SAFE (#2224). ──
        WITH desejado AS (
          SELECT t.ord                                          AS did,
                 (it->>'omie_codigo_produto')::bigint           AS cod,
                 coalesce((it->>'quantity')::numeric, 1)        AS quantity,
                 -- REGUA DE PRECO: identica a de criar_pedidos_com_itens — finitude
                 -- NAO-NEGATIVA. ausente -> NULL; 0 informado -> 0; lixo -> NULL.
                 CASE WHEN (it->>'unit_price')::numeric >= 0
                       AND (it->>'unit_price')::numeric < 'Infinity'::numeric
                      THEN (it->>'unit_price')::numeric END     AS unit_price,
                 coalesce((it->>'discount')::numeric, 0)        AS discount,
                 (it->>'product_id')::uuid                      AS product_id,
                 it->>'hash_payload'                            AS hash_payload,
                 (it->>'omie_codigo_item')::bigint              AS cid
            FROM jsonb_array_elements(v_itens) WITH ORDINALITY AS t(it, ord)
           WHERE (it->>'omie_codigo_produto') IS NOT NULL
        ),
        atual AS (
          SELECT id, omie_codigo_produto AS cod, quantity, unit_price, discount, product_id,
                 omie_codigo_item AS cid
            FROM public.order_items
           WHERE sales_order_id = v_order_id
        ),
        p1 AS (   -- nível 1: identidade de linha (só quando o desejado está TODO identificado)
          SELECT a.id AS aid, d.did
            FROM atual a
            JOIN desejado d ON d.cid = a.cid
           WHERE v_ident AND a.cid IS NOT NULL AND d.cid IS NOT NULL
        ),
        ar AS (SELECT a.* FROM atual a    WHERE NOT EXISTS (SELECT 1 FROM p1 WHERE p1.aid = a.id)),
        dr AS (SELECT d.* FROM desejado d WHERE NOT EXISTS (SELECT 1 FROM p1 WHERE p1.did = d.did)),
        -- 1-1 entre os REMANESCENTES, exigido nos DOIS lados. É esta exigência — e não o G-c —
        -- que impede o valor DOBRADO: duas linhas do mesmo SKU simplesmente não casam com
        -- ninguém, caem no DELETE, e os itens desejados entram pelo INSERT.
        ar1 AS (SELECT cod FROM ar WHERE cod IS NOT NULL GROUP BY cod HAVING count(*) = 1),
        dr1 AS (SELECT cod FROM dr                       GROUP BY cod HAVING count(*) = 1),
        p2 AS (   -- nível 2: SKU. É aqui que a linha legada ADOTA a identidade que veio no item.
          SELECT a.id AS aid, d.did
            FROM ar a
            JOIN dr d ON d.cod = a.cod
           WHERE a.cod IN (SELECT cod FROM ar1)
             AND d.cod IN (SELECT cod FROM dr1)
        ),
        par AS (SELECT aid, did FROM p1 UNION ALL SELECT aid, did FROM p2),
        del AS (
          DELETE FROM public.order_items oi
           USING atual a
           WHERE oi.id = a.id
             AND NOT EXISTS (SELECT 1 FROM par WHERE par.aid = a.id)
          RETURNING 1
        ),
        upd AS (
          UPDATE public.order_items oi
             SET quantity     = d.quantity,
                 unit_price   = d.unit_price,
                 discount     = d.discount,
                 product_id   = d.product_id,
                 -- o update REPARA a identidade do item (hash legado de conteúdo → de identidade)
                 hash_payload = d.hash_payload,
                 -- ADOÇÃO: grava a identidade quando o payload a traz; `coalesce` porque no
                 -- caminho legado `d.cid` é nulo e apagar a identidade já gravada seria regressão
                 omie_codigo_item = coalesce(d.cid, oi.omie_codigo_item)
            FROM par
            JOIN atual a    ON a.id  = par.aid
            JOIN desejado d ON d.did = par.did
           WHERE oi.id = par.aid
             AND NOT (      abs(coalesce(a.quantity,   0) - d.quantity)   < 1e-6
                        -- NULL-SAFE desde que unit_price virou nullable. O
                        -- `coalesce(a.unit_price,0)` anterior passaria a MENTIR: item sem
                        -- preco (NULL) compararia igual a um desejado 0 e o UPDATE nao
                        -- rodaria. Aqui NULL==NULL e "igual" (nao reescreve) e NULL vs
                        -- numero e "diferente" (reescreve), que e a semantica correta.
                        AND (    (a.unit_price IS NULL AND d.unit_price IS NULL)
                              OR (a.unit_price IS NOT NULL AND d.unit_price IS NOT NULL
                                  AND abs(a.unit_price - d.unit_price) < 1e-6) )
                        AND abs(coalesce(a.discount,   0) - d.discount)   < 1e-6
                        AND a.product_id IS NOT DISTINCT FROM d.product_id
                        -- a adoção precisa ser um motivo PRÓPRIO de escrita: sem este termo, um
                        -- pedido cujo conteúdo não mudou nunca ganharia identidade, e a coluna
                        -- ficaria vazia para sempre nos pedidos estáveis — o desenho inteiro
                        -- nasceria INERTE sem ninguém ver
                        AND (d.cid IS NULL OR a.cid IS NOT DISTINCT FROM d.cid) )
          -- separa CORREÇÃO de conteúdo (money-path) de ADOÇÃO de identidade (metadado): contar
          -- as duas como "correção" inflaria, na primeira passada, a métrica que o log publica
          RETURNING (CASE WHEN abs(coalesce(a.quantity,   0) - d.quantity)   < 1e-6
                           AND (    (a.unit_price IS NULL AND d.unit_price IS NULL)
                                 OR (a.unit_price IS NOT NULL AND d.unit_price IS NOT NULL
                                     AND abs(a.unit_price - d.unit_price) < 1e-6) )
                           AND abs(coalesce(a.discount,   0) - d.discount)   < 1e-6
                           AND a.product_id IS NOT DISTINCT FROM d.product_id
                          THEN 0 ELSE 1 END) AS conteudo_mudou
        ),
        ins AS (
          -- `created_at` fica de fora: o trigger `trg_order_items_created_at_omie` herda a data do
          -- PAI para todo pedido `omie\_%`. Passá-la aqui duplicaria a regra em dois lugares.
          INSERT INTO public.order_items (
            sales_order_id, customer_user_id, product_id, omie_codigo_produto,
            quantity, unit_price, discount, hash_payload, omie_codigo_item
          )
          SELECT v_order_id, v_customer, d.product_id, d.cod,
                 d.quantity, d.unit_price, d.discount, d.hash_payload, d.cid
            FROM desejado d
           WHERE NOT EXISTS (SELECT 1 FROM par WHERE par.did = d.did)
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM del),
               (SELECT count(*) FROM upd WHERE conteudo_mudou = 1),
               (SELECT count(*) FROM upd WHERE conteudo_mudou = 0),
               (SELECT count(*) FROM ins)
          INTO v_del, v_upd, v_adot, v_ins;
      END;

      -- Adoção de identidade NÃO é revisão de itens: o conteúdo money-path da linha é o
      -- mesmo. Contá-la aqui faria a primeira passada parecer uma reconciliação em massa
      -- que não houve.
      v_itens_mudaram := (v_del + v_upd + v_ins) > 0;
      v_corrections   := v_corrections + v_del + v_upd + v_ins;
      v_id_adotada    := v_id_adotada + v_adot;

      -- [A4] status só reconcilia com etapa CONHECIDA (status_omie não-nulo) e status local ainda
      -- gerido pelo Omie — nunca rebaixa para 'importado' por leitura malformada nem clobbera
      -- status app-avançado. NUNCA toca hash_payload do pai (causa-raiz #B).
      -- ⚠️ A autoridade aqui é `c_status_omie`, a constante — NÃO o parâmetro. O parâmetro é um
      -- CHECKSUM: ele existe para o TS DECLARAR o que acha que é a lista, e o banco conferir. Se
      -- ele fosse a autoridade, remover o guard de igualdade lá em cima bastaria para uma lista
      -- vinda de fora clobberar status app-avançado. Assim, o guard e o efeito são defesas
      -- INDEPENDENTES: derrubar uma não abre a outra (provado em F2b do harness).
      v_status_novo  := CASE WHEN v_status_omie IS NOT NULL AND v_status_atual = ANY (c_status_omie)
                             THEN v_status_omie ELSE v_status_atual END;
      v_status_mudou := v_status_atual IS DISTINCT FROM v_status_novo;
      v_total_mudou  := abs(coalesce(v_total_atual, 0) - v_total_novo) > 0.01;
      -- ── P1-3 (achado do challenge): a decisão de gravar ignorava `items` e `subtotal` atuais.
      --    Efeitos concretos disso: uma mudança só de descrição/cor no retrato virava NO-OP
      --    PERMANENTE; um estado legado "filhos novos, cabeçalho antigo" nunca era reparado se
      --    total e status coincidissem; e um `subtotal` torto sozinho jamais se corrigia. Uma
      --    reconciliação declarativa que não compara o que grava não é declarativa. ──
      v_cab_mudou := v_status_mudou
                  OR v_total_mudou
                  OR v_items_atual IS DISTINCT FROM v_items_json
                  OR abs(coalesce(v_subtotal_atual, 0) - v_total_novo) > 0.01
                  -- o próprio carimbo do CAS precisa avançar, senão uma leitura nova que não muda
                  -- nada deixaria o pedido preso no carimbo antigo e reabriria a janela de stale
                  OR v_lido_atual IS DISTINCT FROM p_lido_em;

      IF v_cab_mudou OR v_itens_mudaram THEN
        UPDATE public.sales_orders
           SET status     = v_status_novo,
               total      = v_total_novo,
               subtotal   = v_total_novo,
               items      = v_items_json,
               omie_reconciliado_em = p_lido_em,
               updated_at = now()
         WHERE id = v_order_id;
        -- `upserts` conta trabalho REAL. Avançar só o carimbo (leitura nova, conteúdo idêntico)
        -- não é uma reconciliação — contá-la inflaria a métrica que o log publica.
        IF v_status_mudou OR v_total_mudou OR v_itens_mudaram
           OR v_items_atual IS DISTINCT FROM v_items_json
           OR abs(coalesce(v_subtotal_atual, 0) - v_total_novo) > 0.01 THEN
          v_upserts := v_upserts + 1;
        END IF;
        IF v_status_mudou OR v_total_mudou THEN
          v_divergences := v_divergences + 1;
        END IF;
      END IF;

    -- ── P1-4 (achado do challenge): ALLOWLIST, não catch-all. O `WHEN OTHERS` capturava
    --    deadlock (40P01), serialization failure (40001), permissão, relação/coluna ausente e
    --    trigger quebrado como se fossem "um pedido ruim" — e como a função retornava
    --    normalmente, `rpcErr` ficava nulo na edge e a run saía `complete` mesmo com 100 de 100
    --    pedidos falhando. Uma migration não aplicada em metade do schema pareceria um dia de
    --    dados sujos. Aqui ficam só as classes de DADO, que são de fato por-pedido; qualquer
    --    outra sobe e derruba a chamada inteira, que é o desfecho honesto para falha sistêmica.
    EXCEPTION
      WHEN data_exception              -- 22xxx: cast inválido, jsonb malformado, o nosso 22023
        OR integrity_constraint_violation  -- 23xxx: FK de product_id, NOT NULL, unique
      THEN
      -- G8: a falha do pedido é REGISTRADA com SQLSTATE e mensagem, nunca engolida como sucesso
      -- invisível. Tudo que este pedido escreveu foi desfeito pela subtransação.
      v_falhas := v_falhas || jsonb_build_object(
        'hash', v_pedido->>'hash_payload',
        'omie_pedido_id', v_pedido->'omie_pedido_id',
        'sqlstate', SQLSTATE, 'erro', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'upserts',      v_upserts,
    'divergences',  v_divergences,
    'corrections',  v_corrections,
    'sku_repetido', v_sku_repetido,
    'ambiguo',      v_ambiguo,     -- pedidos NÃO tocados por duplicidade de SKU (atual ou desejado)
    'stale',        v_stale,       -- pedidos NÃO tocados por leitura mais velha que a publicada
    'sem_item',     v_sem_item,
    'sem_pai',      v_sem_pai,
    -- SENSORES da adoção de identidade. `identidade_adotada` conta LINHAS que ganharam o
    -- `codigo_item`; `identidade_usada` conta PEDIDOS diffados por ela. Enquanto os dois
    -- forem zero run após run, a resposta é que o ListarPedidos não traz `det.ide.codigo_item`
    -- — e essa é a medição que nenhum payload persistido permitia fazer.
    'identidade_adotada', v_id_adotada,
    'identidade_usada',   v_id_usada,
    'falhas',       v_falhas);
END;
$function$

;

-- Grants: só service_role executa; revogar anon/authenticated POR NOME (REVOKE FROM PUBLIC não
-- tira grant explícito). `DROP`+`CREATE` resetaria o ACL — por isso `CREATE OR REPLACE`.
REVOKE ALL ON FUNCTION public.reconciliar_pedidos_omie(jsonb, text[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconciliar_pedidos_omie(jsonb, text[], timestamptz) TO service_role;

COMMENT ON FUNCTION public.reconciliar_pedidos_omie(jsonb, text[], timestamptz) IS
  'Fase 2 de criar_pedidos_com_itens: reconcilia pedido Omie ALTERADO (itens + cabeçalho) numa ÚNICA transação por pedido. '
  'Diff DECLARATIVO computado dentro da transação sob FOR UPDATE do pai (sem TOCTOU, idempotente). '
  'Casamento em DOIS NÍVEIS: (1) omie_codigo_item (identidade de linha do Omie) quando o desejado está TODO identificado; '
  '(2) omie_codigo_produto, só onde é 1-1 entre os remanescentes nos DOIS lados — e é o nível 2 que ADOTA a identidade '
  'incrementalmente, dispensando backfill. Ambiguidade de identidade é guardada nos DOIS lados (payload e banco) e PULA o pedido inteiro. '
  'Preço segue a régua de finitude não-negativa e o diff dele é NULL-SAFE (#2224): item sem preço NÃO compara igual a 0. '
  'Fail-closed: lista de status por igualdade de conjunto, total/items/p_lido_em ausentes LANÇAM, lote com teto não-contornável. '
  'Compare-and-set por p_lido_em (leitura VELHA não sobrescreve revisão nova). '
  'Lote ordenado por (account,hash_payload) contra deadlock AB/BA. EXCEPTION por ALLOWLIST (22xxx/23xxx); classe sistêmica RELANÇA. '
  'Retorna {upserts,divergences,corrections,sku_repetido,ambiguo,stale,sem_item,sem_pai,identidade_adotada,identidade_usada,falhas[]}.';

-- ── 3. POSTCONDIÇÃO — a migration ABORTA se não pegar, na cara de quem colou ────────────────
-- Não é decoração: o Lovable aplica isto MANUALMENTE, e uma colagem parcial (o founder pega meio
-- bloco, o SQL Editor corta) terminaria em "Success" com o banco meio-mudado. Cada assert abaixo
-- é o predicado da query de validação INVERTIDO, e o A3 é o que esta fatia aprendeu a caro:
-- ele afirma o que NÃO pode ter sido perdido, não só o que foi ganho.
DO $post$
BEGIN
  -- A1: a coluna existe (o ganho)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='order_items' AND column_name='omie_codigo_item'
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: order_items.omie_codigo_item não existe — sem a coluna a RPC abaixo nem compila o diff, e a reconciliação de pedido LANÇA em produção';
  END IF;

  -- A2: a função tem o casamento em DOIS NÍVEIS (o objeto existir não basta: a versão VELHA
  --     também "existe", e passaria num assert de mera existência)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='reconciliar_pedidos_omie'
       AND p.prosrc LIKE '%ar1%' AND p.prosrc LIKE '%omie_codigo_item%'
  ) THEN
    RAISE EXCEPTION 'A2 FALHOU: reconciliar_pedidos_omie não tem o casamento em dois níveis — a função existe, mas é a versão ANTERIOR: pedido de SKU repetido segue congelado e a coluna nunca é adotada';
  END IF;

  -- A3: o diff de preço do #2224 CONTINUA NULL-SAFE. Esta migration recria a função inteira; se
  --     ela tivesse sido derivada do corpo de 30/08, o `coalesce(a.unit_price,0)` voltaria e item
  --     sem preço passaria a comparar IGUAL a zero — o UPDATE não rodaria, e a margem do cliente
  --     seguiria com receita 0 e custo cheio. Reversão silenciosa, invisível no diff do PR.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='reconciliar_pedidos_omie'
       AND p.prosrc LIKE '%a.unit_price IS NULL AND d.unit_price IS NULL%'
  ) THEN
    RAISE EXCEPTION 'A3 FALHOU: o diff NULL-safe de preço (#2224, migration 20260905225613) foi REVERTIDO por esta migration — item sem preço voltaria a comparar igual a 0';
  END IF;

  -- A4: o ACL não afrouxou. `CREATE OR REPLACE` preserva o ACL, mas se alguém tiver dropado a
  --     função antes de colar, ela renasce com EXECUTE para PUBLIC — e esta é uma RPC de ESCRITA.
  IF has_function_privilege('anon', 'public.reconciliar_pedidos_omie(jsonb, text[], timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reconciliar_pedidos_omie(jsonb, text[], timestamptz)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'A4 FALHOU: anon/authenticated EXECUTAM a RPC de escrita — o REVOKE não pegou (função dropada antes do apply renasce com EXECUTE para PUBLIC)';
  END IF;
END
$post$;

COMMIT;
