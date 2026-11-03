-- ============================================================
-- Aposenta public.customer_preferred_items (cache congelado desde 2026-06-08).
--
-- O único escritor era a action `historico_produtos_cliente` da omie-vendas-sync, sem chamador
-- desde #682; o único leitor do front (Customer 360) passou a derivar de `sales_orders` em #3537,
-- e a edge v1.32 (atestada em prod 2026-11-02) removeu as duas actions que tocavam a tabela.
-- Preflight `db/preflight-dependencia-tabela.sql` na PROD (2026-11-02): zero bloqueadores — só
-- defaults/constraints/policies/trigger da própria tabela, que caem junto. O dado é derivável
-- de `sales_orders`, então não há o que preservar.
--
-- DDL destrutivo: aplicação pelo founder no SQL Editor (docs/agent/database.md §1).
-- ============================================================

BEGIN;

DROP TABLE IF EXISTS public.customer_preferred_items;

DO $post$
BEGIN
  IF to_regclass('public.customer_preferred_items') IS NOT NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: public.customer_preferred_items ainda existe — o DROP não pegou';
  END IF;
  RAISE NOTICE 'customer_preferred_items removida';
END
$post$;

COMMIT;
