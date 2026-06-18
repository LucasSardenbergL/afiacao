-- Atomicidade pai+filho do sync de pedidos Omie (sales_orders/order_items)
-- Spec: docs/superpowers/specs/2026-06-17-atomicidade-pedido-itens-omie-design.md
-- Achado #5 do /codex challenge ao sub-projeto 1 do cursor+lease. Money-path:
-- order_items alimenta positivação/OTE/comissão; sales_price_history alimenta pricing.
--
-- Provado em PG17 local (db/test-criar-pedidos-com-itens.sh) com falsificação.
-- ⚠️ MIGRATION MANUAL — Lovable NÃO auto-aplica nome custom. Colar no SQL Editor → Run.
-- Idempotente (CREATE OR REPLACE FUNCTION); re-colar é seguro.
--
-- O índice uniq_sales_orders_omie_hash (account, hash_payload) WHERE hash_payload LIKE 'omie\_%'
-- vem da migration 20260617133634 (#929) — aplicar ANTES desta. O ON CONFLICT abaixo usa o MESMO
-- predicado 'omie\_%' (o ON CONFLICT exige match EXATO do predicado do índice parcial: 'omie_%'
-- com underscore-wildcard NÃO casa 'omie\_%' com underscore-literal → 42P10; testado em PG17).

-- ── RPC transacional pai+filho (fronteira única; substitui 2 inserts PostgREST) ──
CREATE OR REPLACE FUNCTION public.criar_pedidos_com_itens(p_pedidos jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER            -- G1: edge já usa service_role; DEFINER seria write-primitive à toa
SET search_path = ''       -- G1: nomes qualificados (public.*); built-ins via pg_catalog
AS $$
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
               coalesce((it->>'unit_price')::numeric, 0),
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
$$;

COMMENT ON FUNCTION public.criar_pedidos_com_itens(jsonb) IS
  'Sync Omie: insere pai+filhos atômico (subtransação/pedido). ON CONFLICT parcial (account,hash_payload). '
  'Repara órfão (pai sem itens) só se cabeçalho compatível (G5) — não reconcilia pedido alterado (Fase 2). '
  'created_at dos filhos = created_at do pai. Retorna {inserted,repaired,skipped_complete,skipped_no_items,divergence[],failed[]}.';

-- ── 3. Grants (G1): só service_role executa; revogar anon/authenticated por NOME (§54 database.md) ──
REVOKE ALL ON FUNCTION public.criar_pedidos_com_itens(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.criar_pedidos_com_itens(jsonb) TO service_role;
