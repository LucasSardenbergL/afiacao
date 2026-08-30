-- ATOMICIDADE LÓGICA DO PEDIDO — a Fase 2 que `criar_pedidos_com_itens` (20260617160000) nomeou
-- e deixou aberta, e que o #2132 reencontrou por outro caminho ao fechar a CESTA RASGADA.
--
-- ⚠️ MIGRATION MANUAL — Lovable NÃO auto-aplica nome custom. Colar no SQL Editor → Run.
-- Idempotente (CREATE OR REPLACE FUNCTION); re-colar é seguro.
-- Provado em PG17 local (db/test-reconciliar-pedidos-omie.sh) com falsificação.
--
-- ── O DEFEITO, E POR QUE ELE NÃO É O MESMO QUE O #2132 FECHOU ──────────────────────────────
-- O #2132 deu uma garantia de LEITURA: `apriori_universo_snapshot`/`cockpit_itens_snapshot`
-- devolvem tudo de UM instante do banco, porque exatamente uma query toca as tabelas. Isso fecha
-- a cesta rasgada — um estado que NUNCA existiu, artefato da paginação.
--
-- Não fecha ESTE. `sync-reprocess` repartia a reconciliação de um pedido em VÁRIAS transações
-- PostgREST: N inserts de item (uma cada), M updates (uma cada), 1 delete dos removidos, 1 update
-- do cabeçalho. Entre a primeira e a última existe um instante REAL e COMMITADO em que o pedido
-- tem itens da revisão nova convivendo com itens da revisão velha, e um cabeçalho que ainda não
-- fala de nenhuma das duas. O snapshot lê esse instante CORRETAMENTE — porque ele existiu. A
-- distinção é o coração do assunto e não pode ser perdida: a cesta rasgada era perda de PRECISÃO
-- na leitura; esta é falta de atomicidade na ESCRITA, e nenhum conserto de leitor a alcança.
--
-- Onde dói: os MESMOS dois consumidores. `omie-analytics-sync` publica REGRA DE ASSOCIAÇÃO
-- globalmente — uma cesta que mistura duas revisões vira uma regra que ninguém explica depois.
-- `fin-valor-cockpit` deriva margem/EVP — receita meio-reconciliada vira número errado.
--
-- ── POR QUE A RPC DE ESCRITA (caminho `a`), E NÃO `order_revision` + ponteiro (caminho `b`) ──
-- Não é preferência: `a` já é o desenho vigente deste repo, e esta entrega é o buraco que ele
-- declarou. `criar_pedidos_com_itens` fez exatamente isto para o INSERT de pedido novo em
-- 2026-06-17 (#929), foi provado em PG17 com falsificação, passou pelo challenge Codex — e o
-- COMMENT dela diz, textualmente, "não reconcilia pedido alterado (Fase 2)". É esta função.
--
-- Contra `b`, três coisas que a medição e o código sustentam:
--   1. `b` PRECISA de `a`. Trocar `published_revision` sem rasgar é uma transação — a mesma
--      primitiva. `b` é `a` mais um modelo de dados novo, não uma alternativa a `a`.
--   2. `b` toca TODO leitor de `order_items`, não os dois da pendência: `recommend`,
--      `analyze-unified-order`, `algorithm-a-audit`, `usePropostaPreview`, `useHistoricoCompras`
--      e as views SQL. Cada um teria de filtrar pela revisão publicada, e quem esquecesse leria
--      revisão NÃO publicada — falha ABERTA e silenciosa, a classe que este repo persegue.
--      `a` fecha a janela para todos eles sem mudar leitor nenhum, inclusive os que ainda paginam.
--   3. `b` migra as ~70 mil linhas vivas de `order_items` para carregar `revision_id`. Backfill
--      no caminho do dinheiro, para um ganho — histórico de revisões — que a pendência não pede.
--
-- ── A RECONCILIAÇÃO É DECLARATIVA, E ISSO NÃO É DETALHE DE ESTILO ─────────────────────────────
-- A RPC recebe o conjunto DESEJADO de itens e computa o diff ela mesma, DENTRO da transação.
-- A alternativa barata era o TS mandar o diff já pronto (`diffOrderItens`), mas esse diff nasce
-- de um SELECT que aconteceu FORA da transação: entre a leitura e a aplicação, um item que
-- nascesse não estaria nem em `inserir` nem em `deletar` e SOBREVIVERIA — a revisão aplicada
-- seria "a nova, mais um estranho". Atômica e errada. Computar o diff aqui dentro, sob o
-- `FOR UPDATE` do pai, faz o pós-estado ser exatamente o desejado, sempre, e torna a chamada
-- idempotente de verdade: rodar duas vezes com o mesmo payload converge.
--
-- ── MEDIDO EM PROD (psql-ro, 2026-08-30) ─────────────────────────────────────────────────────
-- `sync_reprocess_log`, entity_type='orders', 14 dias: 182 runs (cron `15 */2 * * *`, 12/dia,
-- em pleno horário comercial), 18,9 s de duração média e 60,2 s de máxima, 152 correções de item
-- e 136 pedidos com upsert. A janela é de BAIXA FREQUÊNCIA — ~10 pedidos reconciliados por dia —
-- e isso está dito de propósito: o que justifica a correção não é o volume, é que o produto do
-- consumidor é publicado (regra de associação global, margem), e ali precisão > recall.
-- Duração << intervalo do cron ⇒ dois ciclos não se sobrepõem; o `FOR UPDATE` do pai não está
-- aqui por causa disso, e sim para serializar contra `criar_pedidos_com_itens` (que trava o mesmo
-- pai) e contra invocação manual.
--
-- ── O QUE ESTA FUNÇÃO **NÃO** RESOLVE ────────────────────────────────────────────────────────
-- O snapshot mensal `carteira-positivacao-snapshot` lê QUATRO fontes em instantes distintos e
-- persiste em lotes de 500 em transações separadas. Atomizar o pedido não torna aquele snapshot
-- consistente — segue aberto, e está registrado em docs/historico/paginacao-offset-janela.md.

-- ── P1-2 (challenge): a coluna que torna o CAS possível ──────────────────────────────────────
-- `FOR UPDATE` serializa CHEGADA, não VERSÃO. Sem carimbo de frescor, um run que buscou o pedido
-- às 14:00 pode chegar ao banco DEPOIS de um run que buscou às 16:00 — e sobrescrever a revisão
-- nova com a velha, atomicamente. O lock não vê isso: para ele as duas escritas são igualmente
-- legítimas, só chegaram em certa ordem.
--
-- ⚠️ POR QUE NÃO `infoCadastro.dAlt/hAlt` DO OMIE, que seria a revisão de ORIGEM e portanto o
-- discriminante mais forte: **não consegui PROVAR que o `ListarPedidos` os devolve.** Eles não
-- aparecem em nenhum ponto do repo (só `dInc`), e os 156 payloads de pedido em
-- `omie_webhook_events` têm ZERO ocorrência de `dAlt`. Pendurar um guard money-path num campo
-- cuja existência eu não verifiquei seria fabricar garantia — e um `dAlt` sempre NULL degradaria
-- o CAS para "aceita tudo" SEM ERRO NENHUM, que é a falha aberta que este repo persegue.
--
-- O carimbo abaixo é o instante em que a EDGE buscou a página no Omie. Ele não é a revisão da
-- origem, e isto está dito: é a ordem de LEITURA. Mas é exatamente o eixo do defeito relatado
-- ("run A buscou R1, run B buscou R2 e publicou, A chega atrasada e sobrescreve"), e tem a
-- propriedade que importa — é gerado por quem leu, não inferido por quem escreve.
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS omie_reconciliado_em timestamptz;

COMMENT ON COLUMN public.sales_orders.omie_reconciliado_em IS
  'Instante em que a edge BUSCOU no Omie a revisão que gerou a última reconciliação deste pedido. '
  'Escrito por UM writer só (reconciliar_pedidos_omie) e usado como compare-and-set: uma leitura '
  'mais VELHA que esta não sobrescreve. NULL = nunca reconciliado por este caminho (aceita a 1ª).';

-- A assinatura ganhou `p_lido_em` no conserto do challenge. `CREATE OR REPLACE` com aridade nova
-- criaria uma SOBRECARGA e deixaria a versão de 2 argumentos viva — e o PostgREST poderia resolver
-- para ela, reconciliando sem compare-and-set nenhum. Derrubar a antiga é o que impede isso.
-- (Conferido em prod 2026-08-30: nenhuma das duas existe ainda, então isto é defesa, não reparo.)
DROP FUNCTION IF EXISTS public.reconciliar_pedidos_omie(jsonb, text[]);

CREATE OR REPLACE FUNCTION public.reconciliar_pedidos_omie(
  p_pedidos jsonb,
  p_status_gerido_omie text[],
  -- Instante da BUSCA no Omie da página que gerou este payload (um por run, gerado pela edge).
  -- Fail-closed: sem ele não há como distinguir leitura fresca de leitura velha, e o lock sozinho
  -- deixaria a velha vencer.
  p_lido_em timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER            -- espelha a irmã: a edge já usa service_role; DEFINER seria write-primitive à toa
SET search_path = ''        -- nomes qualificados (public.*); built-ins via pg_catalog
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
  v_atual_dup     integer;
  v_items_atual   jsonb;
  v_subtotal_atual numeric;
  v_lido_atual    timestamptz;
  v_cab_mudou     boolean;
  v_stale         integer := 0;
  v_ambiguo       integer := 0;
  v_del int; v_upd int; v_ins int;
  v_itens_mudaram boolean;
  v_status_mudou  boolean;
  v_total_mudou   boolean;

  v_upserts       integer := 0;
  v_divergences   integer := 0;
  v_corrections   integer := 0;
  v_sku_repetido  integer := 0;
  v_sem_item      integer := 0;
  v_sem_pai       integer := 0;
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
      v_del := 0; v_upd := 0; v_ins := 0;

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
      SELECT count(*), count(DISTINCT (it->>'omie_codigo_produto')::bigint)
        INTO v_n_validos, v_n_distintos
        FROM jsonb_array_elements(v_itens) AS it
       WHERE (it->>'omie_codigo_produto') IS NOT NULL;
      IF v_n_validos = 0 THEN
        v_sem_item := v_sem_item + 1;
        CONTINUE;
      END IF;

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

      BEGIN
        -- ── A reconciliação INTEIRA numa única statement. As três CTEs de escrita enxergam o
        --    MESMO snapshot inicial, que é exatamente o que se quer: os três conjuntos são
        --    disjuntos por construção (remover / atualizar / inserir), então nenhuma precisa ver
        --    o efeito da outra. Espelha `diffOrderItens` do TS, inclusive a tolerância de 1e-6
        --    que evita reescrever linha por ruído de ponto flutuante. ──
        WITH desejado AS (
          SELECT (it->>'omie_codigo_produto')::bigint          AS cod,
                 coalesce((it->>'quantity')::numeric, 1)       AS quantity,
                 coalesce((it->>'unit_price')::numeric, 0)     AS unit_price,
                 coalesce((it->>'discount')::numeric, 0)       AS discount,
                 (it->>'product_id')::uuid                     AS product_id,
                 it->>'hash_payload'                           AS hash_payload
            FROM jsonb_array_elements(v_itens) AS it
           WHERE (it->>'omie_codigo_produto') IS NOT NULL
        ),
        atual AS (
          SELECT id, omie_codigo_produto AS cod, quantity, unit_price, discount, product_id
            FROM public.order_items
           WHERE sales_order_id = v_order_id
        ),
        del AS (
          DELETE FROM public.order_items oi
           USING atual a
           WHERE oi.id = a.id
             AND NOT EXISTS (SELECT 1 FROM desejado d WHERE d.cod = a.cod)
          RETURNING 1
        ),
        upd AS (
          UPDATE public.order_items oi
             SET quantity     = d.quantity,
                 unit_price   = d.unit_price,
                 discount     = d.discount,
                 product_id   = d.product_id,
                 -- o update REPARA a identidade do item (hash legado de conteúdo → de identidade)
                 hash_payload = d.hash_payload
            FROM atual a
            JOIN desejado d ON d.cod = a.cod
           WHERE oi.id = a.id
             AND NOT (      abs(coalesce(a.quantity,   0) - d.quantity)   < 1e-6
                        AND abs(coalesce(a.unit_price, 0) - d.unit_price) < 1e-6
                        AND abs(coalesce(a.discount,   0) - d.discount)   < 1e-6
                        AND a.product_id IS NOT DISTINCT FROM d.product_id )
          RETURNING 1
        ),
        ins AS (
          -- `created_at` fica de fora: o trigger `trg_order_items_created_at_omie` herda a data do
          -- PAI para todo pedido `omie\_%`. Passá-la aqui duplicaria a regra em dois lugares.
          INSERT INTO public.order_items (
            sales_order_id, customer_user_id, product_id, omie_codigo_produto,
            quantity, unit_price, discount, hash_payload
          )
          SELECT v_order_id, v_customer, d.product_id, d.cod,
                 d.quantity, d.unit_price, d.discount, d.hash_payload
            FROM desejado d
           WHERE NOT EXISTS (SELECT 1 FROM atual a WHERE a.cod = d.cod)
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM del), (SELECT count(*) FROM upd), (SELECT count(*) FROM ins)
          INTO v_del, v_upd, v_ins;
      END;

      v_itens_mudaram := (v_del + v_upd + v_ins) > 0;
      v_corrections   := v_corrections + v_del + v_upd + v_ins;

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
    'falhas',       v_falhas);
END;
$function$;

-- Grants: só service_role executa; revogar anon/authenticated POR NOME (REVOKE FROM PUBLIC não
-- tira grant explícito). `DROP`+`CREATE` resetaria o ACL — por isso `CREATE OR REPLACE`.
REVOKE ALL ON FUNCTION public.reconciliar_pedidos_omie(jsonb, text[], timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconciliar_pedidos_omie(jsonb, text[], timestamptz) TO service_role;

COMMENT ON FUNCTION public.reconciliar_pedidos_omie(jsonb, text[], timestamptz) IS
  'Fase 2 de criar_pedidos_com_itens: reconcilia pedido Omie ALTERADO (itens + cabeçalho) numa ÚNICA transação por pedido, '
  'fechando a janela em que o pedido ficava meio-reconciliado e visível aos consumidores money-path. '
  'Diff DECLARATIVO computado dentro da transação sob FOR UPDATE do pai (sem TOCTOU, idempotente). '
  'Fail-closed: lista de status por igualdade de conjunto, total/items/p_lido_em ausentes LANÇAM, lote com teto não-contornável. '
  'Compare-and-set por p_lido_em (leitura VELHA não sobrescreve revisão nova). Duplicidade de omie_codigo_produto — no estado ATUAL ou no desejado — PULA o pedido inteiro (SKU não é identidade de linha). '
  'Lote ordenado por (account,hash_payload) contra deadlock AB/BA. EXCEPTION por ALLOWLIST (22xxx/23xxx); classe sistêmica RELANÇA. '
  'Retorna {upserts,divergences,corrections,sku_repetido,ambiguo,stale,sem_item,sem_pai,falhas[]}.';
