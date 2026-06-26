-- get_ultimos_precos_cliente: ÚLTIMO preço praticado por (cliente, produto), lido de ORDER_ITEMS
-- (a fonte de verdade = o item real do pedido), NÃO de sales_price_history (sph).
--
-- POR QUÊ (psql-ro 2026-06-25, money-path): o "preço-cliente" mostrado ao vendedor na criação de
-- pedido (useCustomerSelection.ts:439) lia SÓ sph com ORDER BY created_at DESC + 1º por produto
-- (resolveLocalPricesByOmieCode). O writer legado omie-analytics-sync (aposentado 2026-06-24) inseriu
-- em sph linhas com created_at = data de CARGA (jun/2026), != data do pedido → a linha espúria, sendo
-- a "mais recente", vencia o dedup e MASCARAVA o preço real. Medição: 456 grupos (cliente,produto)
-- com preço errado na tela. order_items NÃO sofre disso (já é canônica p/ recência: trigger
-- 20260624170000) e é a MESMA fonte que get_regua_preco e analyze-unified-order já usam.
--
-- CONTRATO ENDURECIDO (Codex challenge high, 2026-06-25):
--  • filtra pelo PAI so.customer_user_id (oi.customer_user_id não tem constraint c/ o pai) + defesa oi=so;
--  • exclui status NÃO-praticados (cancelado/orcamento) — get_regua_preco não filtra, mas "praticado" deve;
--  • data efetiva = COALESCE(order_date_kpi, created_at @ America/Sao_Paulo) com ANTI-FUTURO (<= hoje)
--    e desempate DETERMINÍSTICO (created_at do pai, do filho, id) — ordenar por created_at cru reabriria
--    a poluição por data de carga;
--  • product_id IS NOT NULL (coluna NULLABLE em order_items — senão DISTINCT ON agrupa os NULLs);
--  • ACCOUNT-BLIND (MVP, decisão founder 2026-06-25): 0 clientes compram o mesmo SKU nas 2 contas
--    (oben moveleira / colacor abrasivos = catálogos disjuntos). A limitação latente (mesmo mapa p/ as
--    2 contas no frontend) fica documentada; account-aware (DISTINCT ON (account, omie_codigo)) entra
--    quando houver caso real;
--  • SECURITY DEFINER + search_path='' + nomes public.* + REVOKE/GRANT (hardening > get_regua_preco,
--    cujo search_path='public' é menos defensivo).
--
-- Os 32 (cliente,produto) que existem em sph mas NÃO em order_items (preços "fantasma" do writer
-- legado, sem item de pedido vivo) DEGRADAM p/ preço-tabela na tela — seguro (degrada p/ null, NÃO
-- fabrica número). Não é dedup de sph: sph fica intacta p/ audit/histórico.
--
-- Provado em PG17 local com falsificação: db/test-get-ultimos-precos-cliente.sh.
-- ⚠️ MIGRATION MANUAL — Lovable NÃO auto-aplica nome custom. Colar TUDO no SQL Editor → Run.

CREATE OR REPLACE FUNCTION public.get_ultimos_precos_cliente(p_customer uuid)
RETURNS TABLE(product_id uuid, unit_price numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Gate de staff (espelha get_regua_preco). DEFINER expõe order_items de qualquer cliente; a tela de
  -- seleção já é staff-only e account-blind hoje — escopo de carteira não muda aqui (status quo).
  IF NOT (public.has_role(auth.uid(), 'employee'::public.app_role)
          OR public.has_role(auth.uid(), 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'forbidden: get_ultimos_precos_cliente exige staff' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT DISTINCT ON (oi.product_id) oi.product_id, oi.unit_price
  FROM public.order_items oi
  JOIN public.sales_orders so ON so.id = oi.sales_order_id
  WHERE oi.customer_user_id = p_customer
    AND oi.customer_user_id = so.customer_user_id                       -- defesa: filho não vaza vs pai
    AND so.deleted_at IS NULL
    AND COALESCE(so.status, '') NOT IN ('cancelado', 'orcamento')        -- só preço praticado
    AND oi.unit_price > 0
    AND oi.product_id IS NOT NULL
    AND COALESCE(so.order_date_kpi,
                 (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) <= current_date  -- anti-futuro
  ORDER BY oi.product_id,
           COALESCE(so.order_date_kpi,
                    (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) DESC,          -- + recente
           so.created_at DESC, oi.created_at DESC, oi.id DESC;           -- desempate determinístico
END;
$$;

COMMENT ON FUNCTION public.get_ultimos_precos_cliente(uuid) IS
  'Último preço praticado por (cliente,produto) lido de order_items (fonte de verdade), ordenado por '
  'order_date_kpi. Substitui a leitura de sales_price_history no frontend (poluída pelo writer legado). '
  'Staff-only, account-blind (MVP). Money-path — migration 20260625120000.';

-- DEFINER + gate interno: defesa em profundidade na fronteira de privilégio.
REVOKE ALL ON FUNCTION public.get_ultimos_precos_cliente(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ultimos_precos_cliente(uuid) TO authenticated;
