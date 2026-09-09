-- IDENTIDADE DE LINHA NO NASCIMENTO DO PEDIDO — `criar_pedidos_com_itens` passa a gravar
-- `order_items.omie_codigo_item`, com o guard `G-a` de identidade repetida no payload.
--
-- ⚠️ MIGRATION MANUAL — Lovable NAO auto-aplica nome custom. Colar no SQL Editor → Run.
-- Idempotente (`CREATE OR REPLACE`); re-colar e seguro. Provada em PG17 local
-- (`bash db/test-criar-pedidos-com-itens.sh`) com falsificacao.
--
-- ⚠️⚠️ ESTA MIGRATION EMPILHA SOBRE `20260905225613_preco_ausente_nao_e_zero.sql`. O corpo abaixo
-- foi DERIVADO do corpo VIGENTE por transformacao, nao reescrito: a regua de preco (finitude
-- nao-negativa, ausente→NULL) esta preservada VERBATIM. Recriar a funcao a partir do corpo de
-- 17/06 teria REVERTIDO o #2224 em silencio — "a ultima a recriar VENCE" (database.md §4), e num
-- apply manual quem vence e quem for colado por ULTIMO, nao quem tem o timestamp maior.
-- PRE-FLIGHT FEITO (psql-ro, 2026-09-08): `pg_get_functiondef` da PROD conferido linha a linha
-- contra o corpo do #2224 — IDENTICO nas 147 linhas de codigo. Se tiver divergido desde entao,
-- esta migration precisa ser RE-DERIVADA do corpo VIVO antes de colar.
-- `CREATE OR REPLACE` (nao DROP+CREATE) preserva o ACL — nenhum REVOKE precisa ser reemitido.
--
-- ── O DEFEITO ─────────────────────────────────────────────────────────────────────────────────
-- `criar_pedidos_com_itens` e a porta de entrada de TODO pedido Omie (`omie-vendas-sync`), e o
-- INSERT em `order_items` nao tinha a coluna `omie_codigo_item`: todo pedido nascia sem
-- identidade de linha. So a `reconciliar_pedidos_omie` adotava a identidade, depois, e apenas
-- para pedidos que caem na janela do `sync-reprocess` (7d operacional / 30d estrategica).
--
-- Consequencia: enquanto `omie_codigo_item` e NULL, um pedido com SKU REPETIDO so escapa do guard
-- de ambiguidade da reconciliacao se o PAYLOAD trouxer identidade completa (`v_ident`). Quando
-- nao traz, o guard pula o pedido INTEIRO — nem itens, nem cabecalho — e o app fica na revisao
-- anterior em silencio. Nascer com identidade torna esse guard INALCANCAVEL por construcao, em
-- vez de contornavel por um contrato de API de terceiro que pode mudar sem aviso.
--
-- ── MEDIDO EM PROD (psql-ro, 2026-09-08) ──────────────────────────────────────────────────────
--   · `ListarPedidos` — o MESMO endpoint que alimenta esta RPC — devolve `det.ide.codigo_item`
--     em **4.220/4.220** itens lidos pelo `sync-reprocess` desde 07/09 20:16 (com denominador:
--     `metadata.itens_com_codigo_item / itens_lidos`). O campo CHEGA; nao e mais suposicao.
--   · 1.067 pedidos (3,4% de 31.249) tem SKU repetido — 494 oben, 573 colacor.
--   · `omie_codigo_item` duplicado no acervo: **0** pedidos. O `G-a` nasce com o acervo limpo.
--   · Apenas 1.024 de 70.956 linhas (1,4%) tem identidade — porque so a reconciliacao a escreve,
--     e ela so alcanca a janela. Este e o buraco que esta migration fecha.
--   · Colacor NUNCA reconcilia (1 run de `orders` em 2026-02-28; 0/19.706 com
--     `omie_reconciliado_em`) ⇒ para essa conta, ESTA RPC e o UNICO caminho possivel de adocao.
--
-- ── O QUE NAO MUDA ────────────────────────────────────────────────────────────────────────────
-- Nenhuma tolerancia de invariante e afrouxada. As CONSTRAINT TRIGGERs de coerencia do agregado
-- (`20260907220000`) comparam (produto, quantidade, preco, desconto) — `omie_codigo_item` NAO
-- entra nesse eixo, entao gravar a coluna nao move o multiset nem toca a invariante. O guard de
-- ambiguidade da reconciliacao segue exatamente como esta: o que muda e a ENTRADA nele.
--
-- ── ESCRITA POR SUBTRACAO (o que NAO se faz aqui) ─────────────────────────────────────────────
-- Nao ha backfill das ~70 mil linhas historicas: o unico leitor de `omie_codigo_item` e a propria
-- reconciliacao, no instante em que o payload a fornece — linha que nunca reconcilia nunca precisa
-- dela (docs/historico/identidade-de-linha-do-item.md). Nao ha UNIQUE em
-- (sales_order_id, omie_codigo_item): o acervo esta limpo hoje, mas um UNIQUE derrubaria o INSERT
-- do pedido inteiro num dado sujo do Omie — o `G-a` degrada para NULL, que e reversivel.

BEGIN;

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
        -- ── IDENTIDADE DE LINHA NO NASCIMENTO (`det.ide.codigo_item`) — o que esta migration
        --    ACRESCENTA ao corpo vigente do #2224. Tudo abaixo veio de la por TRANSFORMACAO:
        --    a regua de preco esta preservada VERBATIM (recriar do corpo de 17/06 teria
        --    revertido o #2224 em silencio — "a ultima a recriar VENCE", database.md §4).
        --
        --    POR QUE: `criar_pedidos_com_itens` nascia com `omie_codigo_item` NULL, e so a
        --    reconciliacao adotava a identidade depois. Enquanto ela e NULL, um pedido com SKU
        --    repetido depende do payload trazer identidade COMPLETA para escapar do guard de
        --    ambiguidade da `reconciliar_pedidos_omie` — e quando nao traz, o pedido inteiro e
        --    PULADO (nem itens, nem cabecalho) e o app fica na revisao velha em silencio.
        --    Nascer com identidade torna esse guard INALCANCAVEL por construcao, em vez de
        --    contornavel. Medido em prod 2026-09-08: o `ListarPedidos` — o MESMO endpoint que
        --    alimenta esta RPC — devolve o campo em 4.220/4.220 itens lidos.
        WITH cand AS (
          SELECT it,
                 -- A REGUA: inteiro POSITIVO em texto decimal (ate 18 digitos, cabe em bigint).
                 -- Um `codigo_item` invalido (vazio, 0, fracionario, negativo, texto) e PIOR que
                 -- ausente: ausente degrada pro casamento por SKU, que e conhecido e guardado;
                 -- um numero fabricado casaria a linha ERRADA dentro do pedido, em silencio, no
                 -- caminho do dinheiro. O regex e TAMBEM o cast seguro — sem ele um shape
                 -- inesperado derruba a subtransacao G9 e perde o pedido inteiro por um campo
                 -- que e opcional por desenho. Espelha `_shared/omie-codigo-item.ts` (a edge
                 -- filtra antes); aqui de novo porque a RPC e a fronteira e nao confia no caller.
                 CASE WHEN (it->>'omie_codigo_item') ~ '^[1-9][0-9]{0,17}$'
                      THEN (it->>'omie_codigo_item')::bigint END AS cid
            FROM jsonb_array_elements(coalesce(v_pedido->'itens', '[]'::jsonb)) AS it
           WHERE (it->>'omie_codigo_produto') IS NOT NULL
        ),
        ga AS (
          -- G-a: a identidade so vale para o pedido INTEIRO quando e DISTINTA entre as linhas
          -- que a trazem — a mesma regua POR PEDIDO do `v_ident` da reconciliacao, nao por
          -- linha. `count(cid)` e `count(DISTINCT cid)` ignoram NULL: ausente NAO e duplicata de
          -- ausente, senao um payload parcialmente lido zeraria a adocao inteira.
          -- Gravar `codigo_item` repetido criaria a condicao `G-b` da `reconciliar_pedidos_omie`
          -- (identidade duplicada no ATUAL), que faz o reconciliador PULAR aquele pedido PARA
          -- SEMPRE — ele congela na revisao velha. Ausente e reversivel; ambiguo gravado nao e.
          SELECT count(cid) = count(DISTINCT cid) AS ok FROM cand
        )
        INSERT INTO public.order_items (
          sales_order_id, customer_user_id, product_id, omie_codigo_produto,
          quantity, unit_price, discount, hash_payload, created_at, omie_codigo_item
        )
        SELECT v_order_id,
               coalesce((c.it->>'customer_user_id')::uuid, (v_pedido->>'customer_user_id')::uuid),
               (c.it->>'product_id')::uuid,
               (c.it->>'omie_codigo_produto')::bigint,
               coalesce((c.it->>'quantity')::numeric, 1),
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
               CASE WHEN (c.it->>'unit_price')::numeric >= 0
                     AND (c.it->>'unit_price')::numeric < 'Infinity'::numeric
                    THEN (c.it->>'unit_price')::numeric END,
               coalesce((c.it->>'discount')::numeric, 0),
               c.it->>'hash_payload',
               v_created_at,  -- G6
               CASE WHEN (SELECT ok FROM ga) THEN c.cid END
        FROM cand c;
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
$function$;

COMMENT ON FUNCTION public.criar_pedidos_com_itens(jsonb) IS
  'Sync Omie: insere pai+filhos atomico (subtransacao/pedido). ON CONFLICT parcial '
  '(account,hash_payload). Preco: finitude nao-negativa, ausente->NULL (#2224). '
  'Identidade de linha: grava order_items.omie_codigo_item quando o payload traz '
  'det.ide.codigo_item DISTINTO entre as linhas do pedido (G-a); repetido -> NULL em todas, '
  'degradando para o casamento por SKU. Ambiguo GRAVADO congelaria o pedido no G-b da '
  'reconciliar_pedidos_omie; ausente e reversivel.';

-- ── POSTCONDICAO EMBUTIDA ─────────────────────────────────────────────────────────────────────
-- `CREATE OR REPLACE` numa funcao que JA existia passa no `EXISTS` mesmo que nada tenha sido
-- aplicado — por isso o assert ancora na PRESENCA do codigo NOVO, nunca na ausencia do antigo
-- (`pg_get_functiondef` devolve o corpo COM os comentarios, e o cabecalho acima cita o defeito
-- pelo nome). Prova a FORMA; o COMPORTAMENTO e provado por EXECUCAO em PG17
-- (`db/test-criar-pedidos-com-itens.sh`), que e onde ele pode ser provado sem escrever em prod.
DO $post$
DECLARE v_src text;
BEGIN
  v_src := pg_get_functiondef(to_regprocedure('public.criar_pedidos_com_itens(jsonb)'));

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: criar_pedidos_com_itens(jsonb) nao existe — nada foi aplicado';
  END IF;

  -- A2: a coluna entrou na LISTA do INSERT. Sem ela o corpo compila e grava NULL para sempre —
  -- a falha silenciosa exata que esta migration existe para fechar.
  IF v_src NOT LIKE '%created_at, omie_codigo_item%' THEN
    RAISE EXCEPTION 'A2 FALHOU: o INSERT de order_items nao lista omie_codigo_item — o REPLACE nao pegou';
  END IF;

  -- A3: o G-a esta no corpo. Gravar identidade SEM ele e pior que nao gravar: identidade
  -- repetida congela o pedido no G-b da reconciliacao, para sempre.
  IF v_src NOT LIKE '%count(cid) = count(DISTINCT cid)%' THEN
    RAISE EXCEPTION 'A3 FALHOU: guard G-a ausente — identidade repetida seria GRAVADA e congelaria o pedido';
  END IF;

  -- A4: CONTROLE NEGATIVO — a regua de preco do #2224 sobreviveu a derivacao. Este assert existe
  -- porque o modo de falha mais caro desta migration nao e ela nao pegar: e ela pegar REVERTENDO
  -- o corpo vigente, e ai `unit_price` volta a fabricar R$ 0,00 onde o Omie nao informou preco.
  IF v_src NOT LIKE '%< ''Infinity''::numeric%' THEN
    RAISE EXCEPTION 'A4 FALHOU: a regua de preco do #2224 sumiu — o corpo foi REVERTIDO, nao derivado';
  END IF;

  -- A5: a coluna alvo existe na tabela (a 20260906180000 tem de estar aplicada ANTES desta).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='order_items' AND column_name='omie_codigo_item'
  ) THEN
    RAISE EXCEPTION 'A5 FALHOU: order_items.omie_codigo_item nao existe — aplique 20260906180000 ANTES';
  END IF;
END
$post$;

COMMIT;
