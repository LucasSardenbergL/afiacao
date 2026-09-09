-- ============================================================
-- desconto_valor atravessa os TRÊS escritores de order_items
--
-- POR QUE OS TRÊS, e não só o da ingestão:
--   `order_items.desconto_valor` nasceu em 20260908072658 e nunca foi escrita (71.006/71.006
--   NULL, medido 2026-09-08). Ligar só `criar_pedidos_com_itens` faria o dado nascer e MORRER:
--
--     aplicar_edicao_pedido_omie   APAGA e reinsere as linhas do pedido. Sem a coluna no
--                                  INSERT, qualquer edição de pedido zera para NULL um desconto
--                                  já apurado. Perda silenciosa: sem erro, sem divergência.
--     reconciliar_pedidos_omie     faz UPDATE de quantidade/preço/produto. Sem tratamento, o
--                                  desconto apurado sobre a base ANTIGA continuaria colado numa
--                                  linha cuja base mudou — pior que perder: afirmar errado.
--
--   Os três são um conjunto ACOPLADO. Aplicar parte deles deixa o dado com prazo de validade.
--
-- A REGRA, uma frase: ao substituir a versão econômica de uma linha, ou se escreve o desconto
-- correspondente, ou se invalida para NULL. Nunca `coalesce(novo, antigo)` — conservar um número
-- cuja validade deixou de ser conhecida é a fabricação com outra roupa.
--
-- POR QUE NENHUM `coalesce(..., 0)`:
--   NULL = NÃO APURADO. 0 = o Omie informou que não há desconto. São fatos DIFERENTES, e o
--   segundo é o único que autoriza receita cheia. O leitor original lia `prod.desconto` — chave
--   que a API do Omie não tem — e o `|| 0` gravou zero em 71.006 linhas por CEGUEIRA, não por
--   medição. A coluna existe para não repetir isso; um coalesce aqui a esvaziaria de sentido.
--
-- GERADA A PARTIR DA PRODUÇÃO, não do repo: as três definições vieram de `pg_get_functiondef`
-- via psql-ro em 2026-09-08, porque apply manual diverge do repo e a última a recriar VENCE
-- (CLAUDE.md · database.md §4). Cada patch foi aplicado com âncora única verificada.
--
-- NÃO MEXE em `discount` (coluna legado, default 0, 7 consumidores com 2 fórmulas), nem no
-- subtotal/total do pedido. Corrigir o total é entrega própria: mudaria números em telas
-- existentes e mexeria com o guard G5 de divergência.
-- ============================================================

BEGIN;

-- ── CONSOLIDADA com o #2405, que mergeou em 2026-09-09 ───────────────────────────────────────
-- A versão anterior deste arquivo trazia uma PRÉ-CONDIÇÃO que abortava se encontrasse
-- `omie_codigo_item` em `criar_pedidos_com_itens`: naquele momento o #2405 estava aberto, e
-- aplicar este arquivo por cima teria REVERTIDO o trabalho dele em silêncio — `CREATE OR REPLACE`
-- substitui o corpo inteiro, sem erro e sem diff visível ("última a rodar vence", database.md §2).
--
-- Com o #2405 mergeado, a base oficial passou a ser a dele. A seção 1/3 abaixo foi REGENERADA a
-- partir da migration `20260908163659` — a função carrega os DOIS campos, e o guard vira o seu
-- oposto: a postcondição no fim cobra `omie_codigo_item` E `desconto_valor` juntos. Assim a
-- reversão é pega vindo de qualquer lado, em vez de só de um.
--
-- ORDEM DE APPLY: a `20260908163659` primeiro (timestamp menor, e é a ordem natural). Se ela já
-- tiver sido aplicada, esta acrescenta o desconto preservando a identidade; se não tiver, esta
-- entrega as duas coisas de uma vez e a outra, aplicada depois, é idempotente no que interessa.

-- ─────────────── 1/3 · criar_pedidos_com_itens (ingestão do sync) ───────────────
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
          quantity, unit_price, discount, desconto_valor, hash_payload, created_at, omie_codigo_item
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
               -- REGUA DO DESCONTO — sem coalesce, de proposito. `discount` acima e a coluna
               -- LEGADO (default 0, semantica ambigua entre percentual e valor); esta e a
               -- canonica, em R$ da LINHA. NULL aqui significa NAO APURADO, e e diferente de
               -- 0 = "o Omie informou que nao ha desconto". Um `coalesce(...,0)` reintroduziria
               -- a fabricacao que a coluna existe para evitar: o leitor antigo lia
               -- `prod.desconto`, chave que a API do Omie nao tem, e o `|| 0` gravou zero em
               -- 71.006 linhas por CEGUEIRA. Quem calcula e _shared/desconto-omie.ts, na edge.
               (c.it->>'desconto_valor')::numeric,
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
$function$;;

-- ─────────────── 2/3 · aplicar_edicao_pedido_omie (edição de pedido) ───────────────
CREATE OR REPLACE FUNCTION public.aplicar_edicao_pedido_omie(p_sales_order_id uuid, p_items jsonb, p_itens jsonb, p_total numeric, p_notes text, p_omie_payload jsonb, p_omie_response jsonb, p_lido_em timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  -- O Omie aceita `codigo_item_integracao` de 1 a 999 (ver getOmieItemIntegrationCode no edge).
  -- Lote maior que isso não veio da edição — truncar em silêncio seria pior que recusar.
  c_max_itens constant integer := 999;
  v_customer     uuid;
  v_hash_pai     text;
  v_lido_atual   timestamptz;
  v_created_at   timestamptz;
  v_pid_por_sku  jsonb;
  v_n_antes      integer;
  v_n_itens      integer;
  v_n_items      integer;
  v_soma_itens   numeric;
  v_del          integer := 0;
  v_ins          integer := 0;
  v_divergiu     boolean;
BEGIN
  -- ── 1) Entrada fail-closed. Tudo LANÇA: o Omie já está mutado quando isto roda. ──
  IF p_sales_order_id IS NULL THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_sales_order_id ausente'
      USING ERRCODE = '22023';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_items deve ser array jsonb (veio %) — ausente nao e lista vazia',
      jsonb_typeof(p_items) USING ERRCODE = '22023';
  END IF;

  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_itens deve ser array jsonb (veio %) — ausente nao e lista vazia',
      jsonb_typeof(p_itens) USING ERRCODE = '22023';
  END IF;

  v_n_items := jsonb_array_length(p_items);
  v_n_itens := jsonb_array_length(p_itens);

  IF v_n_items = 0 OR v_n_itens = 0 THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: edicao sem itens (items=%, itens=%) — esvaziar o pedido local nao e desfecho de edicao',
      v_n_items, v_n_itens USING ERRCODE = '22023';
  END IF;

  IF v_n_itens > c_max_itens THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: % itens excede o teto de %',
      v_n_itens, c_max_itens USING ERRCODE = '54000';
  END IF;

  IF p_lido_em IS NULL THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_lido_em ausente — sem o instante da leitura final do Omie nao ha como impedir que um pull atrasado reverta esta edicao'
      USING ERRCODE = '22023';
  END IF;

  IF p_lido_em > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_lido_em no futuro (% > %) — relogio do chamador envenenaria o compare-and-set',
      p_lido_em, now() USING ERRCODE = '22023';
  END IF;

  IF p_total IS NULL THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_total ausente — ausente nao e zero'
      USING ERRCODE = '22023';
  END IF;

  -- Regua de finitude nao-negativa (mesma de criar_pedidos_com_itens/reconciliar_pedidos_omie).
  -- Pega NaN tambem: em numeric NaN ordena ACIMA de Infinity, entao `NaN < Infinity` e falso.
  IF NOT (p_total >= 0 AND p_total < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_total invalido (%) — negativo/NaN/infinito nao e total',
      p_total USING ERRCODE = '22023';
  END IF;

  -- Contrato POR ELEMENTO (achado do Codex: dois arrays iguais podem carregar o mesmo dado
  -- invalido). `quantity` e NOT NULL na tabela, `omie_codigo_produto` e a identidade do item no
  -- espelho, e o preco precisa existir e ser finito nao-negativo — sem preco nao ha total.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) AS it
     WHERE (it->>'omie_codigo_produto') IS NULL
        OR (it->>'quantity') IS NULL
        OR (it->>'unit_price') IS NULL
        OR NOT ((it->>'quantity')::numeric  >= 0 AND (it->>'quantity')::numeric  < 'Infinity'::numeric)
        OR NOT ((it->>'unit_price')::numeric >= 0 AND (it->>'unit_price')::numeric < 'Infinity'::numeric)
  ) THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: item sem omie_codigo_produto/quantity/unit_price ou com valor negativo/NaN/infinito'
      USING ERRCODE = '22023';
  END IF;

  -- Desconto: este caminho NAO envia `desconto` ao Omie (ver inclPayload no edge), entao o ERP
  -- grava 0. Aceitar desconto aqui exigiria escolher a formula do total — e a semantica de
  -- `desconto` esta contraditoria entre escritores (o sync aplica qtd*preco*(1-d/100), o cockpit
  -- qtd*preco-d). Recusar e fail-closed: se a edicao ganhar desconto um dia, isto LANCA e forca a
  -- decisao de produto em vez de fabricar um numero.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) AS it
     WHERE (it->>'discount') IS NOT NULL AND (it->>'discount')::numeric <> 0
  ) THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: item com desconto <> 0 — a edicao nao envia desconto ao Omie; a formula do total precisa de decisao de produto'
      USING ERRCODE = '22023';
  END IF;

  -- Com desconto 0 por contrato, o total tem UMA formula so: soma de qtd*preco. `p_total` finito
  -- nao prova que ele corresponde aos itens (achado do Codex) — esta comparacao prova.
  SELECT sum((it->>'quantity')::numeric * (it->>'unit_price')::numeric)
    INTO v_soma_itens
    FROM jsonb_array_elements(p_itens) AS it;

  IF abs(p_total - v_soma_itens) > 0.01 THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_total (%) nao bate com a soma dos itens (%) — cabecalho e linhas contariam historias diferentes',
      p_total, v_soma_itens USING ERRCODE = '22023';
  END IF;

  -- ── 2) Trava o pai. FOR UPDATE serializa contra outra edicao/reconciliacao do MESMO pedido. ──
  SELECT customer_user_id, hash_payload, omie_reconciliado_em
    INTO v_customer, v_hash_pai, v_lido_atual
    FROM public.sales_orders
   WHERE id = p_sales_order_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: pedido % nao existe — o Omie ja foi mutado e nao ha onde gravar a revisao nova',
      p_sales_order_id USING ERRCODE = 'P0002';
  END IF;

  -- Compare-and-set de revisao. Sem isto, um pull que leu o Omie ANTES desta edicao e escreve
  -- DEPOIS reverte tudo — e reverte de forma COERENTE, entao a trigger aceita (achado do Codex).
  -- Escrever o marcador aqui faz a `reconciliar_pedidos_omie` recusar essa leitura velha como
  -- `stale`. O caso inverso (marcador ja mais novo que a nossa leitura) LANCA: e conflito real,
  -- e neste caminho pular em silencio e o pior desfecho possivel.
  IF v_lido_atual IS NOT NULL AND p_lido_em < v_lido_atual THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: pedido % ja tem revisao mais nova gravada (lido_em % < %) — recarregue antes de re-salvar',
      p_sales_order_id, p_lido_em, v_lido_atual USING ERRCODE = '55000';
  END IF;

  -- ── 3) Linhas: substituicao INTEGRAL, e SO quando o pedido ja tinha linhas. ──
  -- Pedido sem linhas e push do app (desenho legitimo, isento da invariante): criar linhas aqui
  -- mudaria QUAIS pedidos sao canonicos — decisao de produto, nao conserto de escritor.
  SELECT count(*), min(created_at)
    INTO v_n_antes, v_created_at
    FROM public.order_items WHERE sales_order_id = p_sales_order_id;

  IF v_n_antes > 0 THEN
    -- `product_id` NAO viaja no items-jsonb do caminho de PULL (construirItemsJson nao grava a
    -- chave), entao a edicao de um pedido canonico manda `product_id` so nos itens que o usuario
    -- ACRESCENTOU pelo catalogo. Substituir as linhas sem mais nada ZERARIA o product_id dos
    -- itens preexistentes — e ele e FK para omie_products e a chave de custo da margem.
    -- Regra: payload vence; onde ele nao sabe, herda o da linha substituida do MESMO SKU, e so
    -- quando aquele SKU tem UM product_id so nas linhas atuais. Ambiguo => NULL (nao adivinha).
    SELECT coalesce(jsonb_object_agg(cod::text, pid), '{}'::jsonb)
      INTO v_pid_por_sku
      FROM (
        SELECT omie_codigo_produto AS cod, min(product_id::text) AS pid
          FROM public.order_items
         WHERE sales_order_id = p_sales_order_id
           AND omie_codigo_produto IS NOT NULL
           AND product_id IS NOT NULL
         GROUP BY omie_codigo_produto
        HAVING count(DISTINCT product_id) = 1
      ) m;

    DELETE FROM public.order_items WHERE sales_order_id = p_sales_order_id;
    GET DIAGNOSTICS v_del = ROW_COUNT;

    INSERT INTO public.order_items (
      sales_order_id, customer_user_id, product_id, omie_codigo_produto,
      quantity, unit_price, discount, desconto_valor, hash_payload, omie_codigo_item, created_at
    )
    SELECT p_sales_order_id,
           v_customer,                              -- do PAI travado, nunca do payload
           coalesce((it->>'product_id')::uuid,
                    (v_pid_por_sku->>(it->>'omie_codigo_produto'))::uuid),
           (it->>'omie_codigo_produto')::bigint,
           (it->>'quantity')::numeric,
           (it->>'unit_price')::numeric,
           -- SEM coalesce: desconto ausente vira NULL, nao 0. O espelho jsonb tem de dizer a
           -- MESMA coisa (a postcondicao cobra), e NULL=NULL nao e divergencia.
           (it->>'discount')::numeric,
           -- O desconto canonico ATRAVESSA a edicao. Esta funcao APAGA e reinsere as linhas do
           -- pedido; sem esta coluna aqui, editar um pedido zeraria para NULL um desconto ja
           -- apurado — perda silenciosa de dado money-path, sem erro e sem divergencia. Segue
           -- sem coalesce: quem edita sem informar desconto deixa a linha NAO APURADA, e o
           -- backfill a re-apura; fabricar 0 aqui afirmaria um fato que ninguem mediu.
           (it->>'desconto_valor')::numeric,
           -- Formato do repo: <hash do pai>_<codigo_produto> (ver o sync). Derivado do PAI de
           -- proposito: o chamador nao consegue forjar um hash de item de outro pedido.
           CASE WHEN v_hash_pai IS NULL THEN NULL
                ELSE v_hash_pai || '_' || (it->>'omie_codigo_produto') END,
           (it->>'omie_codigo_item')::bigint,
           -- Recencia: carrega a data de CARGA que as linhas substituidas ja tinham.
           coalesce(v_created_at, now())
      FROM jsonb_array_elements(p_itens) AS it;
    GET DIAGNOSTICS v_ins = ROW_COUNT;

    IF v_ins <> v_n_itens THEN
      RAISE EXCEPTION 'aplicar_edicao_pedido_omie: inseri % linhas para % itens do payload',
        v_ins, v_n_itens USING ERRCODE = '23514';
    END IF;
  END IF;

  -- ── 4) Cabecalho, na MESMA transacao das linhas. ──
  UPDATE public.sales_orders
     SET items                = p_items,
         subtotal             = p_total,
         total                = p_total,
         notes                = p_notes,
         omie_payload         = p_omie_payload,
         omie_response        = p_omie_response,
         omie_reconciliado_em = p_lido_em,
         updated_at           = now()
   WHERE id = p_sales_order_id;

  -- ── 5) Postcondicao: os dois espelhos, lidos do BANCO, com o predicado da trigger. ──
  IF v_n_antes > 0 THEN
    WITH lado_rel AS (
      SELECT omie_codigo_produto AS prod, quantity AS qtd, unit_price AS preco, discount AS desc_item
        FROM public.order_items WHERE sales_order_id = p_sales_order_id
    ),
    lado_json AS (
      SELECT (el->>'omie_codigo_produto')::bigint AS prod,
             (el->>'quantidade')::numeric         AS qtd,
             (el->>'valor_unitario')::numeric     AS preco,
             (el->>'desconto')::numeric           AS desc_item
        FROM public.sales_orders so CROSS JOIN LATERAL jsonb_array_elements(so.items) el
       WHERE so.id = p_sales_order_id AND jsonb_typeof(so.items) = 'array'
    )
    SELECT EXISTS (
      (TABLE lado_rel EXCEPT ALL TABLE lado_json)
      UNION ALL
      (TABLE lado_json EXCEPT ALL TABLE lado_rel)
    ) INTO v_divergiu;

    IF v_divergiu THEN
      RAISE EXCEPTION
        'aplicar_edicao_pedido_omie: pedido % ficaria incoerente — items(jsonb) e order_items descrevem conjuntos diferentes',
        p_sales_order_id
        USING ERRCODE = '23514',
              CONSTRAINT = 'pedido_venda_coerencia',
              HINT = 'p_items e p_itens tem de descrever os MESMOS (produto, quantidade, preco, desconto); confira a chave desconto/discount';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'sales_order_id',   p_sales_order_id,
    'tinha_linhas',     v_n_antes > 0,
    'linhas_antes',     v_n_antes,
    'linhas_removidas', v_del,
    'linhas_inseridas', v_ins,
    'itens_payload',    v_n_itens);
END;
$function$

;

-- ─────────────── 3/3 · reconciliar_pedidos_omie (sync-reprocess) ───────────────
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
                 -- INVALIDACAO, nao conservacao. Este UPDATE so dispara quando quantidade,
                 -- preco, produto ou identidade DIVERGEM (ver o NOT(...) abaixo) — ou seja,
                 -- quando a base economica sobre a qual o desconto foi apurado deixou de ser a
                 -- desta linha. `coalesce(novo, antigo)` aqui conservaria um numero cuja
                 -- validade acabou de ser perdida, e a linha voltaria a afirmar um desconto que
                 -- ninguem mediu sobre a base nova. NULL = nao apurado, que e a verdade; o
                 -- backfill re-apura depois, contra o detalhe atual do Omie.
                 desconto_valor = NULL,
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
            quantity, unit_price, discount, desconto_valor, hash_payload, omie_codigo_item
          )
          SELECT v_order_id, v_customer, d.product_id, d.cod,
                 d.quantity, d.unit_price, d.discount,
                 -- Linha NOVA vinda da reconciliacao nasce NAO APURADA. A reconciliacao nao le
                 -- o trio de desconto do Omie (ela reconstroi composicao, preco e quantidade),
                 -- entao nao tem o dado — e nao ter o dado se escreve NULL, nunca 0.
                 NULL::numeric,
                 d.hash_payload, d.cid
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

-- ── Postcondição: prova SUFICIÊNCIA, não só que o CREATE passou ───────────────────────────────
-- Um apply PARCIAL (o founder cola metade do bloco, ou uma das três falha) é o modo de falha
-- real aqui, e ele é silencioso: as funções continuam existindo, o sync continua verde, e o
-- desconto simplesmente não atravessa. Por isso o predicado é sobre o CORPO de cada função, não
-- sobre sua existência — existir é o estado de ANTES desta migration.
DO $post$
DECLARE
  v_def text;
  v_faltando text := '';
  r record;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY['criar_pedidos_com_itens',
                        'aplicar_edicao_pedido_omie',
                        'reconciliar_pedidos_omie']) AS fn
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn;

    IF v_def IS NULL THEN
      RAISE EXCEPTION 'FALHOU: public.% não existe — a migration não pegou (ou foi colada pela metade).', r.fn;
    END IF;
    IF position('desconto_valor' in v_def) = 0 THEN
      v_faltando := v_faltando || r.fn || ' ';
    END IF;
  END LOOP;

  IF v_faltando <> '' THEN
    RAISE EXCEPTION 'FALHOU: estas funções não transportam desconto_valor: % — o dado nasceria e morreria no primeiro reprocesso/edição.', v_faltando;
  END IF;

  -- Suficiência ≠ menção: o pior desfecho não é a coluna ausente, é ela presente com
  -- `coalesce(..., 0)`, que grava "desconto zero" em toda linha não apurada e devolve receita
  -- CHEIA. Isso é indistinguível do caso legítimo, e é exatamente o bug que a coluna combate.
  FOR r IN
    SELECT unnest(ARRAY['criar_pedidos_com_itens',
                        'aplicar_edicao_pedido_omie',
                        'reconciliar_pedidos_omie']) AS fn
  LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fn;
    -- `[^)]*` NÃO serve aqui, e a falsificação provou: a forma real é
    -- `coalesce((it->>'desconto_valor')::numeric, 0)`, e a classe negada para no PRIMEIRO `)`,
    -- que é o de `(it->>'desconto_valor')`. O predicado passava verde sobre o texto sabotado.
    -- `[^\n]*` casa dentro da linha inteira; um coalesce quebrado em duas linhas escaparia, e
    -- por isso este predicado não é a única defesa — o efeito é provado executando, em
    -- db/test-desconto-valor-escritores.sh (assert E2).
    IF v_def ~* 'coalesce[^\n]*desconto_valor[^\n]*,\s*0\s*\)'
       OR v_def ~* 'coalesce\s*\(\s*0\s*,[^\n]*desconto_valor' THEN
      RAISE EXCEPTION 'FALHOU: % faz coalesce(desconto_valor, 0) — isso afirma "não há desconto" onde ninguém mediu, e devolve receita cheia.', r.fn;
    END IF;
  END LOOP;

  -- A reconciliação tem de INVALIDAR, não conservar: ela é a única das três que altera a base
  -- econômica de uma linha que já existe.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reconciliar_pedidos_omie';
  IF v_def !~ 'desconto_valor\s*=\s*NULL' THEN
    RAISE EXCEPTION 'FALHOU: reconciliar_pedidos_omie não invalida desconto_valor no UPDATE — o desconto da base ANTIGA ficaria colado numa linha cuja base mudou.';
  END IF;

  -- A identidade de linha do #2405 tem de SOBREVIVER a este replace. Sem esta cobrança, uma
  -- regeneração futura a partir de um snapshot velho a apagaria em silêncio — que é exatamente o
  -- risco que a pré-condição removida acima vigiava, agora fechado pelo lado positivo.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'criar_pedidos_com_itens';
  -- MENÇÃO não basta, e a falsificação provou: a função cita `omie_codigo_item` no guard G-a de
  -- identidade repetida, então uma versão que perdesse a coluna do INSERT continuaria "mencionando"
  -- e a cobrança ficava VERDE sobre o dano. O predicado é sobre a LISTA DE COLUNAS do INSERT.
  IF v_def !~ 'INSERT INTO public\.order_items[^;]*omie_codigo_item' THEN
    RAISE EXCEPTION 'FALHOU: o INSERT de criar_pedidos_com_itens perdeu a coluna omie_codigo_item — este apply reverteria a identidade de linha (#2405). Regenere a partir do pg_get_functiondef atual.';
  END IF;
  IF v_def !~ 'INSERT INTO public\.order_items[^;]*desconto_valor' THEN
    RAISE EXCEPTION 'FALHOU: o INSERT de criar_pedidos_com_itens perdeu a coluna desconto_valor — o desconto apurado não chegaria à tabela.';
  END IF;

  RAISE NOTICE 'OK: os 3 escritores transportam desconto_valor sem coalesce 0, a reconciliação invalida, e a identidade de linha do #2405 sobreviveu.';
END
$post$;

COMMIT;
