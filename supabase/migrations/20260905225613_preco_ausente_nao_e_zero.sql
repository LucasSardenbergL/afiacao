-- ============================================================================
-- Preço ausente do Omie deixa de virar R$ 0,00 — a ORIGEM (banco)
--
-- PROBLEMA. Item sem `valor_unitario` no Omie chegava ao app como preço ZERO.
-- `order_items.unit_price` era NOT NULL DEFAULT 0 e a RPC de ingestão fazia
-- `coalesce(…, 0)`, então "não sei o preço" e "foi de graça" viravam o MESMO
-- byte. Na margem do cliente esse item entrava com receita 0 e custo CHEIO —
-- margem negativa FABRICADA, que rebaixava o health score.
--
-- POR QUE AGORA, se prod tem 0 itens com preço 0 (70.852 medidos, psql-ro
-- 2026-09-05)? Porque o caso é LATENTE, não inexistente — e porque a defesa que
-- já existe hoje é INALCANÇÁVEL: `private.margem_cliente_agregada()` testa
-- `preco_unit IS NOT NULL`, mas a coluna é NOT NULL — esse ramo NUNCA executa em
-- produção. O harness db/test-margem-cliente-helper-compartilhado.sh prova esse
-- ramo inserindo NULL numa tabela de teste que (ao contrário da prod) permite
-- NULL: verde no teste, morto na prod. Esta migration é o que torna a defesa
-- alcançável. Sem ela, o guard do PR #2206 em src/lib/scoring/margin.ts é meia
-- correção — o TS degrada, o SQL não pode.
--
-- O QUE MUDA
--   A. order_items.unit_price: NOT NULL DEFAULT 0  →  nullable, SEM default.
--      (dropar o DEFAULT é parte da correção: mantê-lo faria todo INSERT que
--       omite a coluna continuar fabricando 0 — a correção seria INERTE.)
--   B. criar_pedidos_com_itens: coalesce(…,0) → régua de FINITUDE NÃO-NEGATIVA, que
--      separa "não informou" (NULL) de "informou 0" (0). A ingestão preserva o fato;
--      quem decide se o preço SERVE para margem é o consumo (D).
--   C. reconciliar_pedidos_omie: mesma régua + diff de preço NULL-safe
--      (obrigatório: com a coluna nullable, o `coalesce(a.unit_price,0)` do
--       diff passaria a comparar NULL como 0 e o UPDATE não rodaria).
--   D. margem_cliente_agregada: `preco_unit >= 0` → `> 0` (0 deixa de ser
--      computável) + cobertura que DISTINGUE sem-preço de sem-custo.
--   E. get_customer_margin_summary: projeta as duas contagens novas.
--   G. get_defasagem_cliente: as somas do preço médio ganham `FILTER (unit_price > 0)`.
--      Sem o filtro no DENOMINADOR, uma linha sem preço dilui a média pela metade.
--   F. melhoria_clientes_por_produto: `ORDER BY … DESC` vira `DESC NULLS LAST`.
--      Obrigatório pelo mesmo motivo de C: a soma de receita passa a devolver NULL para o
--      cliente sem item precificado, e DESC em Postgres é NULLS FIRST — o desconhecido
--      encabeçaria o ranking de quem visitar. Não é a função que estava errada; é esta
--      migration que introduz o NULL, então a correção vem junto.
--
-- ausente ≠ zero — docs/agent/money-path.md
-- ============================================================================

BEGIN;

-- ── A. a coluna passa a poder dizer "não sei" ────────────────────────────────
ALTER TABLE public.order_items ALTER COLUMN unit_price DROP DEFAULT;
ALTER TABLE public.order_items ALTER COLUMN unit_price DROP NOT NULL;

COMMENT ON COLUMN public.order_items.unit_price IS
  'Preço unitário praticado. NULL = NÃO SABIDO (o Omie não informou valor_unitario, ou informou '
  'lixo: negativo/Infinity/NaN), jamais "de graça" — ausente <> zero. Era NOT NULL DEFAULT 0, o que '
  'fabricava R$ 0,00 e fazia o item entrar na margem do cliente com receita 0 e custo cheio. '
  'Um 0 aqui é FATO ("o Omie informou zero" — bonificação/brinde), distinto de NULL; a ingestão '
  'preserva os dois. Quem calcula margem exclui ambos (private.margem_cliente_agregada usa > 0), '
  'porque receita 0 com custo real é margem -100% e envenenaria o agregado.';

-- ── B. RPC de ingestão: grava NULL quando o Omie não informou preço ──────────
-- CREATE OR REPLACE (não DROP): preserva o ACL — postgres/service_role/sandbox_exec.
-- Corpo verbatim da PROD (pg_get_functiondef, 2026-09-05); a ÚNICA mudança é a régua.
CREATE OR REPLACE FUNCTION public.criar_pedidos_com_itens(p_pedidos jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_pedido     jsonb;
  v_account    text;
  v_hash       text;
  v_order_id   uuid;
  v_existing   uuid;
  v_created_at timestamptz;
  v_item_count int;
  v_has_items  boolean;
  v_do_items   boolean;
  v_diverge    boolean;
  v_inserted   int := 0;
  v_repaired   int := 0;
  v_items      int := 0;   -- itens de fato inseridos (impacto do reparo)
  v_n          int;
  v_skipped_complete int := 0;
  v_skipped_no_items int := 0;
  v_divergence jsonb := '[]'::jsonb;
  v_failed     jsonb := '[]'::jsonb;
  v_db_total numeric; v_db_customer uuid;
  v_pl_total numeric; v_pl_customer uuid;
BEGIN
  IF p_pedidos IS NULL OR jsonb_typeof(p_pedidos) <> 'array' THEN
    RAISE EXCEPTION 'p_pedidos deve ser array jsonb (veio %)', jsonb_typeof(p_pedidos)
      USING ERRCODE = '22023';
  END IF;

  FOR v_pedido IN SELECT * FROM jsonb_array_elements(p_pedidos)
  LOOP
    v_order_id := NULL; v_existing := NULL; v_do_items := false;
    BEGIN  -- ── G9: subtransação por pedido (1 ruim não derruba os outros) ──
      v_account := v_pedido->>'account';
      v_hash    := v_pedido->>'hash_payload';
      IF v_account IS NULL OR v_hash IS NULL THEN
        RAISE EXCEPTION 'pedido sem account/hash_payload' USING ERRCODE = '22023';
      END IF;

      -- conta itens VÁLIDOS (com codigo_produto) — base do G7
      SELECT count(*) INTO v_item_count
      FROM jsonb_array_elements(coalesce(v_pedido->'itens', '[]'::jsonb)) AS it
      WHERE (it->>'omie_codigo_produto') IS NOT NULL;

      -- ── tenta inserir o pai: só com item válido (G7); ON CONFLICT parcial (G2) ──
      INSERT INTO public.sales_orders (
        customer_user_id, created_by, items, subtotal, discount, total, status,
        omie_pedido_id, omie_numero_pedido, account, hash_payload, created_at,
        order_date_kpi, notes, customer_address, customer_phone
      )
      SELECT
        (v_pedido->>'customer_user_id')::uuid,
        (v_pedido->>'created_by')::uuid,
        coalesce(v_pedido->'items', '[]'::jsonb),
        coalesce((v_pedido->>'subtotal')::numeric, 0),
        coalesce((v_pedido->>'discount')::numeric, 0),
        coalesce((v_pedido->>'total')::numeric, 0),
        coalesce(v_pedido->>'status', 'importado'),
        (v_pedido->>'omie_pedido_id')::bigint,
        v_pedido->>'omie_numero_pedido',
        v_account, v_hash,
        coalesce((v_pedido->>'created_at')::timestamptz, now()),
        (v_pedido->>'order_date_kpi')::date,
        v_pedido->>'notes', v_pedido->>'customer_address', v_pedido->>'customer_phone'
      WHERE v_item_count > 0
      ON CONFLICT (account, hash_payload) WHERE hash_payload LIKE 'omie\_%'
      DO NOTHING
      RETURNING id, created_at INTO v_order_id, v_created_at;

      IF v_order_id IS NOT NULL THEN
        v_inserted := v_inserted + 1;
        v_do_items := true;                       -- pai novo → grava filhos
      ELSE
        -- não inseriu: ou G7 filtrou (pai novo sem item válido), ou conflito (já existe)
        SELECT id, created_at, total, customer_user_id
          INTO v_existing, v_created_at, v_db_total, v_db_customer
          FROM public.sales_orders
         WHERE account = v_account AND hash_payload = v_hash
         FOR UPDATE;                              -- G3: trava o pai (fecha corrida sem lease)

        IF v_existing IS NULL THEN
          v_skipped_no_items := v_skipped_no_items + 1;     -- G7: pai novo sem item válido
        ELSE
          v_has_items := EXISTS(SELECT 1 FROM public.order_items WHERE sales_order_id = v_existing);
          IF v_has_items THEN
            v_skipped_complete := v_skipped_complete + 1;   -- G4: já completo, no-op
          ELSIF v_item_count = 0 THEN
            v_skipped_no_items := v_skipped_no_items + 1;    -- L2: órfão e payload sem item
          ELSE
            -- ── G5: guard de divergência (reparo ≠ reconciliação) ──
            -- Divergência = sinal de que os ITENS mudaram, não o cabeçalho. NÃO comparamos
            -- status (evolui naturalmente: separacao→faturado→...) nem a data — só travariam
            -- reparos legítimos, escondendo positivação. total = soma dos itens (mesma fórmula
            -- na criação e no reparo) → proxy de mudança de item/valor; tolerância de arredondamento.
            -- customer = reatribuição do pedido a outro cliente (vira outro pedido).
            v_pl_total    := coalesce((v_pedido->>'total')::numeric, 0);
            v_pl_customer := (v_pedido->>'customer_user_id')::uuid;
            v_diverge := (abs(coalesce(v_db_total, 0) - v_pl_total) > 0.01
                       OR v_db_customer IS DISTINCT FROM v_pl_customer);
            IF v_diverge THEN   -- G5: itens/cliente divergem do pai → não repara (Fase 2)
              v_divergence := v_divergence || jsonb_build_object(
                'codigo_pedido', v_pedido->'omie_pedido_id',
                'hash', v_hash, 'motivo', 'cabecalho diverge do payload');
            ELSE
              v_order_id := v_existing;            -- reparo
              v_repaired := v_repaired + 1;
              v_do_items := true;
            END IF;
          END IF;
        END IF;
      END IF;

      IF v_do_items THEN
        -- ── G6: order_items.created_at = created_at do PAI (nunca now()) ──
        INSERT INTO public.order_items (
          sales_order_id, customer_user_id, product_id, omie_codigo_produto,
          quantity, unit_price, discount, hash_payload, created_at
        )
        SELECT v_order_id,
               coalesce((it->>'customer_user_id')::uuid, (v_pedido->>'customer_user_id')::uuid),
               (it->>'product_id')::uuid,
               (it->>'omie_codigo_produto')::bigint,
               coalesce((it->>'quantity')::numeric, 1),
               -- REGUA DE PRECO NA INGESTAO — finitude NAO-NEGATIVA. O `coalesce(...,0)`
               -- anterior mapeava "o Omie nao informou" e "o Omie informou 0" no MESMO byte.
               -- Aqui os dois fatos ficam distintos:
               --   ausente/null  -> NULL  ("nao sei")
               --   0             -> 0     (o Omie DISSE zero: bonificacao/brinde e dado real)
               --   negativo, Infinity, NaN (que o Postgres ordena acima de Infinity) -> NULL
               --                          (lixo, nao dado)
               -- A ingestao NAO decide se o preco serve pra margem — isso e do CONSUMO, onde
               -- private.margem_cliente_agregada() aplica finitude POSITIVA (`> 0`) e exclui
               -- tambem o zero. Destruir o zero aqui perderia informacao da fonte de graca.
               CASE WHEN (it->>'unit_price')::numeric >= 0
                     AND (it->>'unit_price')::numeric < 'Infinity'::numeric
                    THEN (it->>'unit_price')::numeric END,
               coalesce((it->>'discount')::numeric, 0),
               it->>'hash_payload',
               v_created_at  -- G6
        FROM jsonb_array_elements(coalesce(v_pedido->'itens', '[]'::jsonb)) AS it
        WHERE (it->>'omie_codigo_produto') IS NOT NULL;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_items := v_items + v_n;

        -- ── G10: sales_price_history na MESMA transação (created_at coerente). Só se ainda NÃO
        -- houver preço para este pedido — idempotente no reparo (evita duplicar histórico se o
        -- fluxo antigo já gravou preço mas perdeu os itens). ──
        IF NOT EXISTS (SELECT 1 FROM public.sales_price_history WHERE sales_order_id = v_order_id) THEN
          INSERT INTO public.sales_price_history (
            customer_user_id, product_id, unit_price, sales_order_id, created_at
          )
          SELECT coalesce((pr->>'customer_user_id')::uuid, (v_pedido->>'customer_user_id')::uuid),
                 (pr->>'product_id')::uuid,
                 (pr->>'unit_price')::numeric,
                 v_order_id,
                 v_created_at  -- G6
          FROM jsonb_array_elements(coalesce(v_pedido->'precos', '[]'::jsonb)) AS pr
          WHERE (pr->>'product_id') IS NOT NULL
            AND coalesce((pr->>'unit_price')::numeric, 0) > 0;
        END IF;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      -- G8: registra a falha do pedido (SQLSTATE + msg), não engole como sucesso invisível
      v_failed := v_failed || jsonb_build_object(
        'codigo_pedido', v_pedido->'omie_pedido_id',
        'hash', v_pedido->>'hash_payload',
        'sqlstate', SQLSTATE, 'erro', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'inserted', v_inserted, 'repaired', v_repaired, 'items', v_items,
    'skipped_complete', v_skipped_complete, 'skipped_no_items', v_skipped_no_items,
    'divergence', v_divergence, 'failed', v_failed);
END;
$function$

;

-- ── C. RPC de reconciliação: mesma régua + diff NULL-safe ───────────────────
-- Sem o diff NULL-safe, tornar a coluna nullable INTRODUZ bug: `coalesce(a.unit_price,0)`
-- compararia um item sem preço (NULL) como igual a um desejado 0 e o UPDATE não rodaria.
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
                 -- REGUA DE PRECO: identica a de criar_pedidos_com_itens — finitude
                 -- NAO-NEGATIVA. ausente -> NULL; 0 informado -> 0; lixo -> NULL.
                 CASE WHEN (it->>'unit_price')::numeric >= 0
                       AND (it->>'unit_price')::numeric < 'Infinity'::numeric
                      THEN (it->>'unit_price')::numeric END    AS unit_price,
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
                        -- NULL-SAFE desde que unit_price virou nullable. O
                        -- `coalesce(a.unit_price,0)` anterior passaria a MENTIR: item sem
                        -- preco (NULL) compararia igual a um desejado 0 e o UPDATE nao
                        -- rodaria. Aqui NULL==NULL e "igual" (nao reescreve) e NULL vs
                        -- numero e "diferente" (reescreve), que e a semantica correta.
                        AND (    (a.unit_price IS NULL AND d.unit_price IS NULL)
                              OR (a.unit_price IS NOT NULL AND d.unit_price IS NOT NULL
                                  AND abs(a.unit_price - d.unit_price) < 1e-6) )
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
$function$

;

-- ── D. helper de margem: 0 deixa de ser computável + cobertura por MOTIVO ────
-- DROP+CREATE (não REPLACE) porque o RETURNS TABLE ganha colunas — o Postgres recusa
-- REPLACE que mude o tipo de retorno. DROP RESETA o ACL (função nova nasce com EXECUTE
-- para PUBLIC), então os REVOKE/GRANT abaixo NÃO são decorativos: sem eles esta migration
-- ABRIRIA a margem por cliente (⇒ custo agregado) para anon/authenticated. E `private`
-- NÃO fecha: medido em prod, o schema concede USAGE a anon E authenticated — é o REVOKE,
-- e só ele. (CLAUDE.md: "DROP FUNCTION+CREATE RESETA o ACL — reemita nomeando as roles".)
DROP FUNCTION IF EXISTS private.margem_cliente_agregada();

CREATE FUNCTION private.margem_cliente_agregada()
 RETURNS TABLE(customer_user_id uuid, itens_computaveis bigint, itens_ignorados bigint,
               receita_computada numeric, custo_computado numeric, margem_pct numeric,
               itens_sem_preco bigint, itens_sem_custo bigint)
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
$function$;

REVOKE ALL ON FUNCTION private.margem_cliente_agregada() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.margem_cliente_agregada() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION private.margem_cliente_agregada() TO service_role;

COMMENT ON FUNCTION private.margem_cliente_agregada() IS
  'Fonte UNICA da margem bruta por cliente (order_items x omie_products x product_costs). '
  'Universo por DENYLIST de status (inclui separacao/enviado/importado: sao vendas reais, '
  'R$ 6.985.425,66 que a allowlist anterior descartava). JOIN por omie_codigo_produto — '
  'product_id e nulo em 2,67% dos itens. ausente<>zero nas TRES pernas: sem item computavel '
  'devolve NULL, nunca 0. Preco exige > 0 (nao >= 0): enquanto unit_price foi NOT NULL DEFAULT 0, '
  'preco ausente chegava como 0 e era computavel — margem negativa fabricada. itens_sem_preco e '
  'itens_sem_custo SE SOBREPOEM (item sem os dois conta nas duas) e NAO somam itens_ignorados.';

-- ── E. wrapper público: projeta as duas contagens novas ─────────────────────
-- Disciplina de VIEW aplicada a função: só ACRESCENTA coluna NO FIM. As 6 primeiras
-- mantêm nome, tipo e ordem porque a edge calculate-scores lê por nome.
-- ⚠️ `itens_sem_custo` (posição 2) é um nome LEGADO e MENTE um pouco: ele traz
-- `itens_ignorados`, isto é, excluídos por QUALQUER motivo — preço, custo ou quantidade.
-- Renomear quebraria a edge, então a correção é ACRESCENTAR os nomes honestos ao lado
-- (`itens_sem_preco`, `itens_sem_custo_conhecido`) e dizer isto aqui e no COMMENT.
DROP FUNCTION IF EXISTS public.get_customer_margin_summary();

CREATE FUNCTION public.get_customer_margin_summary()
 RETURNS TABLE(customer_user_id uuid, itens_com_custo bigint, itens_sem_custo bigint,
               receita_com_custo numeric, custo_conhecido numeric, gross_margin_pct numeric,
               itens_sem_preco bigint, itens_sem_custo_conhecido bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  SELECT m.customer_user_id,
         m.itens_computaveis,
         m.itens_ignorados,
         m.receita_computada,
         m.custo_computado,
         m.margem_pct,
         m.itens_sem_preco,
         m.itens_sem_custo
    FROM private.margem_cliente_agregada() m;
$function$;

REVOKE ALL ON FUNCTION public.get_customer_margin_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_customer_margin_summary() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_margin_summary() TO service_role;

-- A role do sandbox do Lovable tinha EXECUTE nas DUAS RPCs antes do DROP (medido via
-- proacl em 2026-09-05). Reemitir sob IF EXISTS porque ela não existe no PG17 local das provas.
DO $sandbox$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec_fzvklzpomgnyikkfkzai') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_customer_margin_summary() TO sandbox_exec_fzvklzpomgnyikkfkzai';
  END IF;
END
$sandbox$;

COMMENT ON FUNCTION public.get_customer_margin_summary() IS
  'Margem bruta por cliente para o componente de margem do health score. Desde a reconciliacao '
  '(2026-07-21) e uma PROJECAO de private.margem_cliente_agregada() — nao tem calculo proprio. '
  'Nomes das 6 primeiras colunas preservados para a edge calculate-scores. ATENCAO: itens_sem_custo '
  '(col. 2) e nome LEGADO e traz itens_ignorados (excluidos por QUALQUER motivo); os nomes honestos '
  'sao itens_sem_preco e itens_sem_custo_conhecido, acrescentados no fim, e eles SE SOBREPOEM entre '
  'si. ausente<>zero: cliente sem item computavel devolve NULL, nunca 0. SECURITY DEFINER + EXECUTE '
  'so para service_role.';


-- ── F. ranking que a nullable poria de cabeca para baixo ────────────────────
-- `melhoria_clientes_por_produto` ordena por `sum(quantity * unit_price) DESC LIMIT 50`.
-- Essa soma passa a devolver NULL para o cliente sem NENHUM item precificado, e DESC em
-- Postgres e NULLS FIRST por padrao — o desconhecido subiria ao TOPO do ranking. Nao e a
-- funcao que estava errada: e esta migration que introduz o NULL, entao a correcao vem junto.
-- CREATE OR REPLACE (nao DROP): preserva o ACL, que inclui `authenticated` de proposito
-- (a tela e do vendedor; o gate e `carteira_visivel_para` no corpo, nao o privilegio).
CREATE OR REPLACE FUNCTION public.melhoria_clientes_por_produto(p_termo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_full boolean;
  v_result jsonb;
begin
  if v_uid is null or not (has_role(v_uid,'employee'::app_role) or has_role(v_uid,'master'::app_role)) then
    raise exception 'Apenas staff pode consultar';
  end if;
  if length(trim(coalesce(p_termo,''))) < 3 then
    raise exception 'Termo de busca muito curto (mínimo 3 caracteres)';
  end if;
  v_full := pode_ver_carteira_completa(v_uid);

  with prods as (
    select id, descricao, codigo, account
    from omie_products
    where coalesce(ativo, true) = true
      and (descricao ilike '%' || trim(p_termo) || '%' or codigo ilike '%' || trim(p_termo) || '%')
    order by descricao
    limit 5
  ),
  compras as (
    select oi.customer_user_id,
           count(distinct oi.sales_order_id) as n_pedidos,
           max(coalesce(so.order_date_kpi, so.created_at::date)) as ultima_compra,
           sum(oi.quantity * oi.unit_price) as valor_12m
    from order_items oi
    join sales_orders so on so.id = oi.sales_order_id
    join prods p on p.id = oi.product_id
    where so.status not in ('cancelado','rascunho','pendente')
      and so.deleted_at is null
      and coalesce(so.order_date_kpi, so.created_at::date) >= current_date - interval '12 months'
    group by oi.customer_user_id
  ),
  visiveis as (
    select c.* from compras c
    where v_full or carteira_visivel_para(c.customer_user_id, v_uid)
  ),
  top50 as (
    -- NULLS LAST e OBRIGATORIO desde que order_items.unit_price virou nullable
    -- (20260905225613): `sum(quantity * unit_price)` devolve NULL quando NENHUM item do
    -- cliente tem preco conhecido, e o default do Postgres em DESC e NULLS **FIRST** —
    -- medido: `ORDER BY v DESC` sobre (1,NULL,5) devolve NULL,5,1. Sem isto, o cliente
    -- de quem NAO SE SABE a receita encabecaria o top-50 de melhoria, invertendo a
    -- ordem que a tela usa para decidir quem visitar. "Nao sei" nao e "o maior".
    select * from visiveis order by valor_12m desc nulls last limit 50
  )
  select jsonb_build_object(
    'produtos_casados', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'account', account)), '[]'::jsonb) from prods),
    'clientes', (select coalesce(jsonb_agg(jsonb_build_object(
        'cliente', coalesce(pr.razao_social, pr.name),
        'n_pedidos', t.n_pedidos,
        'ultima_compra', t.ultima_compra,
        'valor_12m', round(t.valor_12m::numeric, 2)
      ) order by t.valor_12m desc nulls last), '[]'::jsonb)
      from top50 t join profiles pr on pr.user_id = t.customer_user_id),
    'total_clientes_visiveis', (select count(*) from visiveis),
    'escopo', case when v_full then 'todos' else 'minha_carteira' end
  ) into v_result;

  return v_result;
end $function$;


-- ── G. media ponderada que a nullable diluiria ──────────────────────────────
-- `get_defasagem_cliente` calcula o ultimo preco praticado por
-- `sum(unit_price * quantity) / sum(quantity)`. Com a coluna nullable, o numerador ignora a
-- linha sem preco (sum pula NULL) mas o denominador CONSERVA a quantidade dela — a media cai
-- pela metade sem que nada indique. O numero fabricado nao para ai: vira `p_req`, markup e a
-- classificacao de defasagem que a tela mostra ao vendedor.
-- Mesmo padrao de C e F: nao e a funcao que estava errada, e esta migration que introduz o
-- NULL. CREATE OR REPLACE preserva o ACL (inclui `authenticated`, de proposito).
CREATE OR REPLACE FUNCTION public.get_defasagem_cliente(p_itens jsonb, p_customer_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- constantes (espelho de DEFASAGEM_CONST do helper)
  c_tol_pp        constant numeric := 3;      -- pontos percentuais
  c_piso_alta     constant numeric := 2;      -- % alta mínima (anti-ruído)
  c_piso_acao_pp  constant numeric := 2;      -- % de p_now
  c_piso_acao_rs  constant numeric := 1;      -- R$ absolutos
  c_ancora_max    constant int     := 18;     -- meses
  c_quarentena    constant numeric := 50;     -- % alta absurda
  c_janela_dias   constant int     := 7;      -- ±dias da data da âncora p/ casar C_last
  c_stale_horas   constant int     := 48;     -- C_now stale se synced_at < now()-48h

  v_pode_num boolean;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_empresa text; v_codigo bigint; v_preco numeric; v_accounts text[];

  v_p_last numeric; v_qtd_ancora numeric; v_data_ancora date;
  v_disc boolean; v_qty_carrinho numeric;
  v_c_last numeric; v_c_now numeric; v_c_now_synced timestamptz;
  v_status text; v_motivo text; v_p_req numeric; v_alta_perc numeric;
  v_markup_ant numeric; v_tem_ancora boolean;
  v_razao numeric; v_alta numeric; v_subiu_preco numeric; v_gap_reais numeric; v_piso_acao numeric;
  v_data_label text;
BEGIN
  -- Gate de staff IDÊNTICO à 2a.
  IF NOT (auth.uid() IS NOT NULL
    AND (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role))) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  IF jsonb_array_length(p_itens) > 200 THEN
    RAISE EXCEPTION 'too many items (max 200)' USING errcode = '22023';
  END IF;
  v_pode_num := private.cap_custo_ler(auth.uid());

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    -- reset por item
    v_p_last := NULL; v_qtd_ancora := NULL; v_data_ancora := NULL; v_disc := NULL;
    v_c_last := NULL; v_c_now := NULL; v_c_now_synced := NULL; v_qty_carrinho := NULL;
    v_status := NULL; v_motivo := NULL; v_p_req := NULL; v_alta_perc := NULL;
    v_markup_ant := NULL; v_tem_ancora := false; v_data_label := NULL;

    v_empresa := lower(v_item->>'empresa');
    v_codigo  := (v_item->>'codigo')::bigint;
    v_preco   := (v_item->>'preco')::numeric;
    v_qty_carrinho := NULLIF(v_item->>'qty','')::numeric;  -- opcional (G5); se ausente, qty_ratio passa

    v_accounts := CASE v_empresa
            WHEN 'oben'       THEN ARRAY['vendas','oben']
            WHEN 'colacor'    THEN ARRAY['colacor_vendas','colacor']
            WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc']
            ELSE ARRAY[v_empresa] END;

    -- ── ÂNCORA: última compra REAL deste cliente p/ este produto (account-aware) ──
    -- Data da âncora: dInc do omie_payload (DD/MM/YYYY) → fallback order_date_kpi.
    -- Pega o pedido mais recente por essa data; média ponderada por quantity é tratada
    -- abaixo (mesmo dia). Aqui resolvemos a DATA e o flag de desconto do pedido vencedor.
    WITH ancora AS (
      SELECT
        oi.unit_price,
        oi.quantity,
        oi.discount AS disc_item,
        so.discount AS disc_pedido,
        COALESCE(
          to_date(NULLIF(so.omie_payload->'infoCadastro'->>'dInc',''),'DD/MM/YYYY'),
          so.order_date_kpi
        ) AS data_real,
        (so.omie_payload->'infoCadastro'->>'dInc') IS NOT NULL
          OR so.order_date_kpi IS NOT NULL AS data_ok
      FROM order_items oi
      JOIN sales_orders so ON so.id = oi.sales_order_id
      WHERE oi.customer_user_id = p_customer_user_id
        AND oi.omie_codigo_produto = v_codigo
        AND so.account = ANY(v_accounts)
        AND so.status IN ('faturado','importado','separacao','enviado')  -- allowlist POSITIVA
        AND so.omie_pedido_id IS NOT NULL
        AND so.deleted_at IS NULL
    ),
    melhor_data AS (
      -- a data da âncora = a maior data_real entre as linhas válidas (com data_ok)
      SELECT max(data_real) AS data_real
      FROM ancora
      WHERE data_ok AND data_real IS NOT NULL
    ),
    no_dia AS (
      -- todas as linhas naquele dia → média ponderada por quantity do unit_price
      SELECT
        a.*,
        (SELECT data_real FROM melhor_data) AS data_alvo
      FROM ancora a
      WHERE a.data_real = (SELECT data_real FROM melhor_data)
    )
    SELECT
      -- ⚠️ As duas somas do PRECO sao FILTRADAS pelas linhas com preco utilizavel; a
      -- quantidade da ancora (linha de baixo) NAO e — sao medidas diferentes.
      -- Sem o FILTER no DENOMINADOR, uma linha sem preco DILUI a media: duas linhas do
      -- mesmo SKU/dia, quantidade 1 cada, precos 100 e NULL, davam 100/2 = 50. Um preco
      -- que ninguem praticou, que depois passa pelo guard positivo e alimenta p_req,
      -- markup e a classificacao de defasagem. [P1 do challenge Codex]
      -- `> 0` e nao `IS NOT NULL`: preco zero informado tambem nao e preco praticado.
      CASE WHEN sum(quantity) FILTER (WHERE unit_price > 0) > 0
           THEN sum(unit_price * quantity) FILTER (WHERE unit_price > 0)
                / sum(quantity) FILTER (WHERE unit_price > 0)
           ELSE NULL END,
      sum(quantity),
      (SELECT data_real FROM melhor_data),
      bool_or(COALESCE(disc_item,0) > 0 OR COALESCE(disc_pedido,0) > 0),
      (count(*) > 0)
    INTO v_p_last, v_qtd_ancora, v_data_ancora, v_disc, v_tem_ancora
    FROM no_dia;

    -- ── C_now: CMC atual freshest (account-aware), + frescor (G6) ──
    SELECT ip.cmc, ip.synced_at
      INTO v_c_now, v_c_now_synced
    FROM inventory_position ip
    WHERE ip.omie_codigo_produto = v_codigo
      AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
      AND ip.account = ANY(v_accounts)
    ORDER BY ip.synced_at DESC NULLS LAST
    LIMIT 1;

    -- ── C_last: cmc_snapshot na data da âncora, janela ±7 dias, o mais próximo ──
    IF v_data_ancora IS NOT NULL THEN
      SELECT cs.cmc
        INTO v_c_last
      FROM cmc_snapshot cs
      WHERE cs.omie_codigo_produto = v_codigo
        AND cs.account = ANY(v_accounts)
        AND cs.cmc > 0 AND cs.cmc <> 'NaN'::numeric
        AND abs(cs.data_posicao - v_data_ancora) <= c_janela_dias
      ORDER BY abs(cs.data_posicao - v_data_ancora) ASC, cs.synced_at DESC
      LIMIT 1;
    END IF;

    -- ════════ REGRA À PROVA DE CATRACA (1:1 com defasagem.ts) ════════
    -- Ordem dos guards = literal da spec §5.2-5.4.
    IF NOT v_tem_ancora THEN
      v_status := 'sem_historico'; v_motivo := 'sem_historico';
    ELSIF v_disc THEN
      v_status := 'neutro'; v_motivo := 'desconto_nao_provado';
    ELSIF v_data_ancora IS NULL THEN
      v_status := 'sem_data_confiavel'; v_motivo := 'sem_data_confiavel';
    ELSIF v_c_now IS NULL OR v_c_now_synced IS NULL
          OR v_c_now_synced < now() - make_interval(hours => c_stale_horas) THEN
      v_status := 'sem_custo_atual_fresco'; v_motivo := 'sem_custo_atual_fresco';
    ELSIF v_c_last IS NULL THEN
      -- sem snapshot na janela → neutro (não arrisca FP — Codex #1)
      v_status := 'neutro'; v_motivo := 'sem_custo_historico';
    ELSIF v_p_last IS NULL OR v_p_last <= 0 OR v_p_last = 'NaN'::numeric
          OR v_c_last <= 0 OR v_c_last = 'NaN'::numeric
          OR v_c_now  <= 0 OR v_c_now  = 'NaN'::numeric THEN
      v_status := 'neutro'; v_motivo := 'sem_base';
    ELSIF v_qty_carrinho IS NOT NULL AND v_qtd_ancora IS NOT NULL AND v_qtd_ancora > 0
          AND (v_qty_carrinho / v_qtd_ancora >= 10 OR v_qtd_ancora / v_qty_carrinho >= 10) THEN
      -- G5: ordem de grandeza divergente → revisar
      v_status := 'revisar'; v_motivo := 'qty_divergente';
    ELSIF EXTRACT(EPOCH FROM (now() - v_data_ancora::timestamptz)) / (86400 * 30.4375) > c_ancora_max THEN
      v_status := 'neutro'; v_motivo := 'ancora_antiga';
    ELSE
      v_razao := v_c_now / v_c_last;
      IF v_razao - 1 > c_quarentena / 100 THEN
        v_status := 'revisar'; v_motivo := 'quarentena_custo';
      ELSIF v_p_last <= v_c_last THEN
        v_status := 'neutro'; v_motivo := 'prejuizo_ancora';   -- G1
      ELSIF v_c_now <= v_c_last THEN
        v_status := 'sem_alta'; v_motivo := 'custo_nao_subiu';
      ELSE
        v_alta := v_razao - 1;
        IF v_alta < c_piso_alta / 100 THEN
          v_status := 'sem_alta'; v_motivo := 'alta_ruido';
        ELSE
          v_p_req := round(v_p_last * v_razao, 2);
          v_alta_perc := v_alta * 100;
          v_subiu_preco := CASE WHEN v_preco > 0 THEN v_preco / v_p_last - 1 ELSE -1 END;
          IF v_subiu_preco < v_alta - c_tol_pp / 100 THEN
            -- passa por razão → testa piso de ação (em R$ arredondado a centavo)
            v_gap_reais := round(v_p_req, 2) - round(v_preco, 2);
            v_piso_acao := greatest((c_piso_acao_pp / 100) * v_preco, c_piso_acao_rs);
            IF v_gap_reais < v_piso_acao THEN
              v_status := 'em_dia'; v_motivo := 'gap_abaixo_do_piso';
            ELSE
              v_status := 'defasado'; v_motivo := 'custo_subiu_preco_nao_acompanhou';
            END IF;
          ELSE
            v_status := 'em_dia'; v_motivo := 'preco_acompanhou';
          END IF;
        END IF;
      END IF;
    END IF;

    -- markup anterior (só p/ gestor) — só faz sentido com base válida.
    IF v_p_last IS NOT NULL AND v_c_last IS NOT NULL AND v_c_last > 0 AND v_c_last <> 'NaN'::numeric THEN
      v_markup_ant := (v_p_last - v_c_last) / v_c_last * 100;
    END IF;

    -- rótulo da data da âncora = MM/AAAA
    v_data_label := CASE WHEN v_data_ancora IS NOT NULL THEN to_char(v_data_ancora,'MM/YYYY') ELSE NULL END;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'codigo', v_codigo, 'empresa', v_empresa,
      'status_defasagem', v_status,
      'tem_ancora', v_tem_ancora,
      'p_req', to_jsonb(v_p_req),
      'alta_custo_perc', to_jsonb(v_alta_perc),
      'data_ancora', to_jsonb(v_data_label),
      'motivo', v_motivo,
      'calculated_at', now(),
      -- role-gated (absolutos só p/ pode_ver_carteira_completa):
      'p_last',         CASE WHEN v_pode_num THEN to_jsonb(v_p_last)      ELSE 'null'::jsonb END,
      'c_last',         CASE WHEN v_pode_num THEN to_jsonb(v_c_last)      ELSE 'null'::jsonb END,
      'c_now',          CASE WHEN v_pode_num THEN to_jsonb(v_c_now)       ELSE 'null'::jsonb END,
      'markup_anterior',CASE WHEN v_pode_num THEN to_jsonb(v_markup_ant)  ELSE 'null'::jsonb END
    ));
  END LOOP;

  RETURN v_out;
END;
$function$;

-- ── Z. postcondição: a migration ABORTA se não pegou ────────────────────────
-- Roda no MESMO Run de quem colou, dentro da transação: uma migration meio-aplicada não
-- termina em silêncio. Verifica SUFICIÊNCIA (o estado que importa), não só existência.
DO $post$
DECLARE
  v_nullable text; v_default text; v_cols int; v_corpo text;
BEGIN
  -- A) a coluna precisa aceitar NULL *e* não ter default — as duas, ou a correção é inerte
  SELECT is_nullable, coalesce(column_default,'(nenhum)')
    INTO v_nullable, v_default
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='order_items' AND column_name='unit_price';
  IF v_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'FALHOU A1: order_items.unit_price continua NOT NULL — preco ausente seguiria virando 0';
  END IF;
  IF v_default <> '(nenhum)' THEN
    RAISE EXCEPTION 'FALHOU A2: order_items.unit_price ainda tem DEFAULT (%) — INSERT que omite a coluna continua fabricando esse valor', v_default;
  END IF;

  -- B) a régua nova precisa estar no corpo das DUAS RPCs de ingestão
  SELECT pg_get_functiondef(p.oid) INTO v_corpo FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='criar_pedidos_com_itens' AND p.prokind='f';
  IF v_corpo LIKE '%coalesce((it->>''unit_price'')::numeric, 0)%' THEN
    RAISE EXCEPTION 'FALHOU B1: criar_pedidos_com_itens ainda faz coalesce(unit_price,0) — segue fabricando preco 0';
  END IF;
  IF v_corpo NOT LIKE '%(it->>''unit_price'')::numeric >= 0%' THEN
    RAISE EXCEPTION 'FALHOU B2: criar_pedidos_com_itens perdeu a regua de finitude nao-negativa';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_corpo FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='reconciliar_pedidos_omie' AND p.prokind='f';
  IF v_corpo LIKE '%abs(coalesce(a.unit_price, 0) - d.unit_price)%' THEN
    RAISE EXCEPTION 'FALHOU C: reconciliar_pedidos_omie mantem o diff NULL-blind — item sem preco compararia igual a 0';
  END IF;

  -- D) a régua do helper: `>= 0` teria deixado o 0 computavel
  SELECT pg_get_functiondef(p.oid) INTO v_corpo FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='private' AND p.proname='margem_cliente_agregada' AND p.prokind='f';
  IF v_corpo LIKE '%preco_unit >= 0%' THEN
    RAISE EXCEPTION 'FALHOU D1: margem_cliente_agregada ainda aceita preco_unit >= 0 — preco 0 segue computavel';
  END IF;
  IF v_corpo NOT LIKE '%preco_unit > 0%' THEN
    RAISE EXCEPTION 'FALHOU D2: margem_cliente_agregada perdeu a regua de preco positivo';
  END IF;

  -- E) as colunas novas existem nas DUAS (8 = 6 legadas + 2)
  SELECT count(*) INTO v_cols FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
    unnest(p.proargmodes) AS m WHERE n.nspname='private' AND p.proname='margem_cliente_agregada'
      AND p.prokind='f' AND m='t';
  IF v_cols <> 8 THEN
    RAISE EXCEPTION 'FALHOU E1: margem_cliente_agregada devolve % colunas, esperava 8', v_cols;
  END IF;
  SELECT count(*) INTO v_cols FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
    unnest(p.proargmodes) AS m WHERE n.nspname='public' AND p.proname='get_customer_margin_summary'
      AND p.prokind='f' AND m='t';
  IF v_cols <> 8 THEN
    RAISE EXCEPTION 'FALHOU E2: get_customer_margin_summary devolve % colunas, esperava 8', v_cols;
  END IF;

  -- F) O ACL — a parte que o DROP reseta e que ABRIRIA custo agregado ao browser.
  --    Este assert é o motivo de a migration poder usar DROP com segurança.
  IF has_function_privilege('anon','private.margem_cliente_agregada()','EXECUTE')
  OR has_function_privilege('authenticated','private.margem_cliente_agregada()','EXECUTE')
  OR has_function_privilege('anon','public.get_customer_margin_summary()','EXECUTE')
  OR has_function_privilege('authenticated','public.get_customer_margin_summary()','EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU F1: anon/authenticated executam a margem — o DROP resetou o ACL e o REVOKE nao pegou';
  END IF;
  IF NOT has_function_privilege('service_role','public.get_customer_margin_summary()','EXECUTE')
  OR NOT has_function_privilege('service_role','private.margem_cliente_agregada()','EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU F2: service_role NAO executa a margem — a edge calculate-scores para de medir';
  END IF;

  -- H) SECURITY DEFINER preservado nas duas (sem ele o SET search_path nao protege nada)
  IF NOT (SELECT bool_and(p.prosecdef) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE (n.nspname='private' AND p.proname='margem_cliente_agregada')
              OR (n.nspname='public'  AND p.proname='get_customer_margin_summary')) THEN
    RAISE EXCEPTION 'FALHOU H: alguma das funcoes de margem perdeu o SECURITY DEFINER';
  END IF;

  -- I) o ranking nao pode ter ficado NULLS FIRST
  SELECT pg_get_functiondef(p.oid) INTO v_corpo FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='melhoria_clientes_por_produto' AND p.prokind='f';
  IF v_corpo IS NULL THEN
    RAISE EXCEPTION 'FALHOU I1: melhoria_clientes_por_produto nao existe — o bloco F nao rodou';
  END IF;
  IF v_corpo NOT LIKE '%valor_12m desc nulls last limit 50%' THEN
    RAISE EXCEPTION 'FALHOU I2: o top-50 segue NULLS FIRST — cliente sem receita conhecida encabeca o ranking';
  END IF;

  -- J) a media ponderada nao pode ter ficado NULL-diluida
  SELECT pg_get_functiondef(p.oid) INTO v_corpo FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_defasagem_cliente' AND p.prokind='f';
  IF v_corpo IS NULL THEN
    RAISE EXCEPTION 'FALHOU J1: get_defasagem_cliente nao existe — o bloco G nao rodou';
  END IF;
  IF v_corpo NOT LIKE '%sum(quantity) FILTER (WHERE unit_price > 0)%' THEN
    RAISE EXCEPTION 'FALHOU J2: o denominador da media segue contando linha sem preco — preco medio fabricado';
  END IF;

  RAISE NOTICE 'OK: unit_price nullable sem default; regua > 0 nas 2 RPCs e no helper; 8 colunas nas 2 funcoes de margem; anon/authenticated FORA, service_role DENTRO; SECURITY DEFINER preservado.';
END
$post$;

COMMIT;
