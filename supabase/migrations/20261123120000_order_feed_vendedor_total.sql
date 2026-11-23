-- /sales PR D — "Meus pedidos" e valor do recorte da listagem (order_feed).
--
-- A view order_feed NÃO muda. Ela é security_invoker e sales_orders é fechada por coluna para
-- `authenticated` (20260709163500); o vendedor ficou de fora de propósito (20261113120000). Pôr
-- `vendedor_user_id` no corpo da view faria TODA leitura de /sales dar 42501 (Codex, P0). Segue-se o
-- precedente de 20261121140000 (pedidos_vendedor): leitura do vendedor por função estreita.
--
-- 1. public.pedidos_ids_do_vendedor(p_vendedor) — SECURITY DEFINER, gate staff pelo usuário REAL
--    (auth.uid()). Devolve só os ids dos pedidos vivos cujo vendedor identificado é p_vendedor.
--    "Meu" = sales_orders.vendedor_user_id (1 escritor: sales_orders_registrar_vendedor_omie) —
--    NÃO created_by (quem digitou no app pode ser outro staff ou o cliente; Codex P1). Sem vendedor
--    identificado (vendedor Omie sem usuário, não lido) e afiação nunca entram. NULL → 22023: um
--    p_vendedor nulo nunca vira "todos".
-- 2. public.order_feed_do_vendedor(p_vendedor) — SETOF order_feed, SQL, SECURITY INVOKER: as linhas
--    da view (a RLS dela vale) restritas a esses ids. A listagem com ?meus=1 lê daqui pelo PostgREST,
--    com os MESMOS filtros/ordem/cursor que aplica na view.
-- 3. public.order_feed_total(...) — count/soma/sem-total do MESMO recorte. Os parâmetros espelham
--    1:1 os filtros do front (src/components/salesOrders/feed.ts → recorteDoFeed):
--      p_account → .eq('account')     p_status → .in('status')  (NULL = "todos")
--      p_desde/p_puros → .or(created_at.gte.<desde>, created_at.eq.<puro>…)  (corte do período)
--      p_customer → .eq('customer_user_id')   p_busca → .ilike('busca', <padrão já com %>)
--      p_vendedor → lê de order_feed_do_vendedor em vez da view
--    soma = round(sum(total), 2): NULL quando nenhum total é conhecido (ausente ≠ zero — "—").
--    sem_total = linhas fora da soma (a tela marca a soma como parcial).
--
-- Idempotente (CREATE OR REPLACE + REVOKE/GRANT). Sem BEGIN/COMMIT: aplica por `bun run db:aplicar`.
-- Prova: db/test-order-feed-vendedor-total.sh (PG17: paridade soma × filtros, gate, RLS, falsificação).

DO $pre$
BEGIN
  IF to_regclass('public.order_feed') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.order_feed ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                 WHERE attrelid = 'public.sales_orders'::regclass AND attname = 'vendedor_user_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'PRE FALHOU: sales_orders.vendedor_user_id ausente (20261113120000 não aplicada)';
  END IF;
END
$pre$;

-- 1 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pedidos_ids_do_vendedor(p_vendedor uuid)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT (coalesce(auth.role(), '') = 'service_role'
          OR (v_uid IS NOT NULL AND (public.has_role(v_uid, 'master'::public.app_role)
                                     OR public.has_role(v_uid, 'employee'::public.app_role)))) THEN
    RAISE EXCEPTION 'PEDIDOS_IDS_DO_VENDEDOR_ACESSO: requer staff' USING ERRCODE = '42501';
  END IF;
  IF p_vendedor IS NULL THEN
    RAISE EXCEPTION 'PEDIDOS_IDS_DO_VENDEDOR_PARAM: p_vendedor nulo' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT so.id FROM public.sales_orders so
    WHERE so.vendedor_user_id = p_vendedor AND so.deleted_at IS NULL;
END
$fn$;

COMMENT ON FUNCTION public.pedidos_ids_do_vendedor(uuid) IS
  'Ids dos pedidos vivos cujo vendedor identificado (sales_orders.vendedor_user_id) é p_vendedor. Staff only (usuário real). NULL → 22023. Base de "Meus pedidos" em /sales.';

REVOKE ALL ON FUNCTION public.pedidos_ids_do_vendedor(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pedidos_ids_do_vendedor(uuid) TO authenticated, service_role;

-- 2 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.order_feed_do_vendedor(p_vendedor uuid)
RETURNS SETOF public.order_feed
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $fn$
  SELECT f.* FROM public.order_feed f
  WHERE f.origin = 'sales'
    AND f.id IN (SELECT d.id FROM public.pedidos_ids_do_vendedor(p_vendedor) d);
$fn$;

COMMENT ON FUNCTION public.order_feed_do_vendedor(uuid) IS
  'Linhas de order_feed (RLS da view vale) dos pedidos do vendedor p_vendedor — "Meus pedidos" em /sales. Afiação e pedido sem vendedor identificado não entram.';

REVOKE ALL ON FUNCTION public.order_feed_do_vendedor(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_feed_do_vendedor(uuid) TO authenticated, service_role;

-- 3 ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.order_feed_total(
  p_account  text          DEFAULT NULL,
  p_status   text[]        DEFAULT NULL,
  p_desde    timestamptz   DEFAULT NULL,
  p_puros    timestamptz[] DEFAULT NULL,
  p_customer uuid          DEFAULT NULL,
  p_busca    text          DEFAULT NULL,
  p_vendedor uuid          DEFAULT NULL
)
RETURNS TABLE (pedidos bigint, soma numeric, sem_total bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- Fonte: a view inteira, ou só os pedidos do vendedor. Um ramo por fonte (não um OR): a função
  -- do vendedor recusa NULL e nunca deve ser avaliada quando o recorte não é "Meus".
  IF p_vendedor IS NULL THEN
    RETURN QUERY
      SELECT count(*)::bigint, round(sum(f.total), 2), count(*) FILTER (WHERE f.total IS NULL)::bigint
      FROM public.order_feed f
      WHERE (p_account  IS NULL OR f.account = p_account)
        AND (p_status   IS NULL OR f.status = ANY (p_status))
        AND (p_desde    IS NULL OR f.created_at >= p_desde OR f.created_at = ANY (COALESCE(p_puros, '{}'::timestamptz[])))
        AND (p_customer IS NULL OR f.customer_user_id = p_customer)
        AND (p_busca    IS NULL OR f.busca ILIKE p_busca);
  ELSE
    RETURN QUERY
      SELECT count(*)::bigint, round(sum(f.total), 2), count(*) FILTER (WHERE f.total IS NULL)::bigint
      FROM public.order_feed_do_vendedor(p_vendedor) f
      WHERE (p_account  IS NULL OR f.account = p_account)
        AND (p_status   IS NULL OR f.status = ANY (p_status))
        AND (p_desde    IS NULL OR f.created_at >= p_desde OR f.created_at = ANY (COALESCE(p_puros, '{}'::timestamptz[])))
        AND (p_customer IS NULL OR f.customer_user_id = p_customer)
        AND (p_busca    IS NULL OR f.busca ILIKE p_busca);
  END IF;
END
$fn$;

COMMENT ON FUNCTION public.order_feed_total(text, text[], timestamptz, timestamptz[], uuid, text, uuid) IS
  'Valor do recorte da listagem /sales: os MESMOS filtros que o front aplica em order_feed (feed.ts → recorteDoFeed). soma NULL = nenhum total conhecido (ausente ≠ zero). SECURITY INVOKER: RLS da view vale igual.';

REVOKE ALL ON FUNCTION public.order_feed_total(text, text[], timestamptz, timestamptz[], uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_feed_total(text, text[], timestamptz, timestamptz[], uuid, text, uuid) TO authenticated, service_role;

-- PÓS: ACL das três (anon fora nas DUAS pontas; authenticated dentro) e a view intocada.
DO $pos$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.pedidos_ids_do_vendedor(uuid)',
    'public.order_feed_do_vendedor(uuid)',
    'public.order_feed_total(text, text[], timestamptz, timestamptz[], uuid, text, uuid)'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: ACL de % (anon fora, authenticated dentro)', v_fn;
    END IF;
  END LOOP;
  IF has_column_privilege('authenticated', 'public.sales_orders', 'vendedor_user_id', 'SELECT') THEN
    RAISE EXCEPTION 'POS FALHOU: authenticated lê sales_orders.vendedor_user_id direto — o fecho por coluna é de propósito';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c, unnest(c.reloptions) o
    WHERE c.oid = 'public.order_feed'::regclass AND o IN ('security_invoker=true', 'security_invoker=on')
  ) THEN
    RAISE EXCEPTION 'POS FALHOU: order_feed sem security_invoker';
  END IF;
END
$pos$;

NOTIFY pgrst, 'reload schema';
