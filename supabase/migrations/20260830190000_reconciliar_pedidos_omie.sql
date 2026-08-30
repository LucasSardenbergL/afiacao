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

CREATE OR REPLACE FUNCTION public.reconciliar_pedidos_omie(
  p_pedidos jsonb,
  p_status_gerido_omie text[]
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
  v_recon_itens   boolean;
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

  IF jsonb_array_length(p_pedidos) > c_max_pedidos THEN
    RAISE EXCEPTION 'reconciliar_pedidos_omie: lote de % pedidos excede o teto de % — divida a chamada (truncar em silêncio seria pior)',
      jsonb_array_length(p_pedidos), c_max_pedidos
      USING ERRCODE = '54000';
  END IF;

  FOR v_pedido IN SELECT * FROM jsonb_array_elements(p_pedidos)
  LOOP
    -- ── subtransação por pedido (G9 da irmã): um pedido ruim não derruba os outros, e o que ele
    --    tiver escrito até o erro é DESFEITO — que é justamente a atomicidade lógica pedida aqui.
    --    Substitui o "grava itens primeiro, cabeçalho só se nenhum item falhou" que o TS fazia à
    --    mão, e que nunca cobriu a falha ENTRE dois writes de item. ──
    BEGIN
      v_order_id := NULL; v_recon_itens := true;
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
      SELECT id, customer_user_id, status, total
        INTO v_order_id, v_customer, v_status_atual, v_total_atual
        FROM public.sales_orders
       WHERE account = v_account AND hash_payload = v_hash
       FOR UPDATE;
      IF v_order_id IS NULL THEN
        v_sem_pai := v_sem_pai + 1;
        CONTINUE;
      END IF;

      -- [A7] SKU repetido no pedido é AMBÍGUO: a identidade do item dentro do pedido é o
      -- `omie_codigo_produto`, e com repetição não dá para dizer qual linha local casa com qual.
      -- Pula o reconcile de ITENS (não arrisca deletar linha legítima); o cabeçalho ainda
      -- reconcilia, porque total/items somam TODAS as linhas, igual ao sync.
      -- ⚠️ Quem detecta é a FUNÇÃO, não o chamador. Um parâmetro `p_reconciliar_itens` deixaria a
      -- decisão com quem pode esquecer de tomá-la, e o custo do esquecimento é apagar item real.
      IF v_n_distintos <> v_n_validos THEN
        v_recon_itens  := false;
        v_sku_repetido := v_sku_repetido + 1;
      END IF;

      IF v_recon_itens THEN
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
      END IF;

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

      IF v_status_mudou OR v_total_mudou OR v_itens_mudaram THEN
        UPDATE public.sales_orders
           SET status     = v_status_novo,
               total      = v_total_novo,
               subtotal   = v_total_novo,
               items      = v_items_json,
               updated_at = now()
         WHERE id = v_order_id;
        v_upserts := v_upserts + 1;
        IF v_status_mudou OR v_total_mudou THEN
          v_divergences := v_divergences + 1;
        END IF;
      END IF;

    EXCEPTION WHEN OTHERS THEN
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
    'sem_item',     v_sem_item,
    'sem_pai',      v_sem_pai,
    'falhas',       v_falhas);
END;
$function$;

-- Grants: só service_role executa; revogar anon/authenticated POR NOME (REVOKE FROM PUBLIC não
-- tira grant explícito). `DROP`+`CREATE` resetaria o ACL — por isso `CREATE OR REPLACE`.
REVOKE ALL ON FUNCTION public.reconciliar_pedidos_omie(jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconciliar_pedidos_omie(jsonb, text[]) TO service_role;

COMMENT ON FUNCTION public.reconciliar_pedidos_omie(jsonb, text[]) IS
  'Fase 2 de criar_pedidos_com_itens: reconcilia pedido Omie ALTERADO (itens + cabeçalho) numa ÚNICA transação por pedido, '
  'fechando a janela em que o pedido ficava meio-reconciliado e visível aos consumidores money-path. '
  'Diff DECLARATIVO computado dentro da transação sob FOR UPDATE do pai (sem TOCTOU, idempotente). '
  'Fail-closed: lista de status por igualdade de conjunto, total/items ausentes LANÇAM, lote com teto não-contornável. '
  'Retorna {upserts,divergences,corrections,sku_repetido,sem_item,sem_pai,falhas[]}.';
