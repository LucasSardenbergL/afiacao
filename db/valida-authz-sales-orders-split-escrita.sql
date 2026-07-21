-- ╔════════════════════════════════════════════════════════════════════════════╗
-- ║ VALIDAÇÃO PÓS-APPLY — FU4 split de escrita em sales_orders + filhas        ║
-- ║ Migration: 20260724120000_authz_sales_orders_split_escrita_fu4.sql        ║
-- ╚════════════════════════════════════════════════════════════════════════════╝
--
-- Só LÊ CATÁLOGO — nunca INVOCA private.cap_pedido_escrever (§4/FU4-E, #1462):
--   (a) `SELECT cap(NULL)` sem cast é `unknown` → "function does not exist",
--       que se lê como "não aplicou" e empurra para re-aplicar o que está são;
--   (b) invocar exige EXECUTE → sob psql-ro (claude_ro) vem "permission denied",
--       que é o REVOKE FUNCIONANDO se apresentando como falha da migration.
-- Lendo catálogo, roda igual no psql-ro e no SQL Editor (superuser).
--
-- ESPERADO: 10 linhas, todas com ok = t.

WITH checks AS (

  -- 1. o FOR ALL broad-staff (o BFLA) não existe mais em nenhuma das 3
  SELECT 1 AS n, 'sem policy FOR ALL nas 3 tabelas' AS descricao,
         (count(*) = 0)::text AS ok, count(*)::text AS valor
  FROM pg_policies
  WHERE schemaname='public' AND tablename IN ('sales_orders','order_items','sales_price_history')
    AND cmd='ALL'

  UNION ALL
  -- 2. sales_orders: 4 policies staff (SELECT/INSERT/UPDATE/DELETE) + 1 do customer
  SELECT 2, 'sales_orders tem 5 policies (4 staff + 1 customer)',
         (count(*) = 5)::text, count(*)::text
  FROM pg_policies WHERE schemaname='public' AND tablename='sales_orders'

  UNION ALL
  -- 3. filhas: só as 2 de SELECT cada (staff + customer), zero de escrita
  SELECT 3, 'order_items + sales_price_history: 2 policies cada, só SELECT',
         (count(*) = 4 AND count(*) FILTER (WHERE cmd='SELECT') = 4)::text,
         count(*)::text
  FROM pg_policies
  WHERE schemaname='public' AND tablename IN ('order_items','sales_price_history')

  UNION ALL
  -- 4. o predicado de estado está no USING do DELETE.
  --    Casa por VALOR ('omie_pedido_id', 'orcamento'), nunca por sintaxe — o
  --    pg_get_expr re-serializa (IN vira = ANY (ARRAY[...])) e um ILIKE '%IN (%'
  --    daria falso-negativo com o fix aplicado (§4).
  SELECT 4, 'predicado de estado no USING do DELETE',
         COALESCE(bool_and(qual ~ 'omie_pedido_id' AND qual ~ 'orcamento' AND qual ~ 'rascunho'), false)::text,
         COALESCE(max(left(qual, 60)), '(sem policy DELETE)')
  FROM pg_policies
  WHERE schemaname='public' AND tablename='sales_orders' AND cmd='DELETE'

  UNION ALL
  -- 5. a capability existe e tem a propriedade de CORPO esperada: inclui employee
  --    (positivo) e não arrastou outro gate (negativo — validação sem negativo
  --    aceita qualquer corpo que mencione a palavra certa)
  SELECT 5, 'cap_pedido_escrever inclui employee + master, sem outro gate',
         (count(*) = 1)::text, count(*)::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='private' AND p.proname='cap_pedido_escrever'
    AND pg_get_functiondef(p.oid) ~ 'employee'
    AND pg_get_functiondef(p.oid) ~ 'master'
    AND pg_get_functiondef(p.oid) ~ 'COALESCE'
    AND pg_get_functiondef(p.oid) !~ 'gerencial|estrategico|carteira|pode_ver_carteira_completa'

  UNION ALL
  -- 6. ALLOWLIST de UPDATE: exatamente as 11 colunas medidas.
  --    Larga demais reabre o bypass PATCH→DELETE; estreita demais quebra o front
  --    em silêncio. Por isso o assert é de IGUALDADE, não de contém.
  SELECT 6, 'UPDATE de authenticated = exatamente as 11 colunas da allowlist',
         (count(*) FILTER (WHERE tem) = 11 AND count(*) FILTER (WHERE tem AND NOT esperada) = 0)::text,
         count(*) FILTER (WHERE tem)::text || ' colunas graváveis'
  FROM (
    SELECT a.attname,
           has_column_privilege('authenticated','public.sales_orders',a.attname,'UPDATE') AS tem,
           a.attname = ANY (ARRAY['items','subtotal','total','notes','customer_document',
                                  'customer_address','customer_phone','ready_by_date',
                                  'omie_payload','deleted_at','status']) AS esperada
    FROM pg_attribute a
    WHERE a.attrelid='public.sales_orders'::regclass AND a.attnum>0 AND NOT a.attisdropped
  ) s

  UNION ALL
  -- 7. PRESERVAÇÃO: os grants de SELECT por coluna do PR0.0-bis sobreviveram.
  --    É o assert do risco que quase passou — um REVOKE ALL (em vez de REVOKE
  --    UPDATE) os teria destruído e quebrado a leitura do front inteiro.
  SELECT 7, 'SELECT por coluna do PR0.0-bis intacto (25 legíveis / 3 sensíveis)',
         (count(*) FILTER (WHERE tem) = 25 AND count(*) FILTER (WHERE NOT tem) = 3)::text,
         count(*) FILTER (WHERE tem)::text || ' legíveis'
  FROM (
    SELECT has_column_privilege('authenticated','public.sales_orders',a.attname,'SELECT') AS tem
    FROM pg_attribute a
    WHERE a.attrelid='public.sales_orders'::regclass AND a.attnum>0 AND NOT a.attisdropped
  ) s

  UNION ALL
  -- 8. filhas: leitura preservada, DML e TRUNCATE fechados p/ authenticated
  SELECT 8, 'filhas: authenticated lê, mas sem INSERT/UPDATE/DELETE/TRUNCATE',
         (bool_and(has_table_privilege('authenticated','public.'||t,'SELECT'))
          AND NOT bool_or(has_table_privilege('authenticated','public.'||t,'INSERT')
                       OR has_table_privilege('authenticated','public.'||t,'UPDATE')
                       OR has_table_privilege('authenticated','public.'||t,'DELETE')
                       OR has_table_privilege('authenticated','public.'||t,'TRUNCATE')))::text,
         'ok'
  FROM unnest(ARRAY['order_items','sales_price_history']) t

  UNION ALL
  -- 9. service_role INTACTO — se isto virar f, as edges (omie-vendas-sync,
  --    sync-reprocess) e a RPC criar_pedidos_com_itens param de escrever
  SELECT 9, 'service_role segue com DML nas 3 (edges + RPC preservadas)',
         bool_and(has_table_privilege('service_role','public.'||t,'INSERT')
              AND has_table_privilege('service_role','public.'||t,'UPDATE')
              AND has_table_privilege('service_role','public.'||t,'DELETE'))::text,
         'ok'
  FROM unnest(ARRAY['sales_orders','order_items','sales_price_history']) t

  UNION ALL
  -- 10. InitPlan: detector é ILIKE '%select%' COM ESPAÇO possível — '%(select%'
  --     dá falso-0 porque o pg_get_expr renderiza o sublink como "( SELECT" (§4)
  SELECT 10, 'todas as policies das 3 wrapped em InitPlan',
         (count(*) = 0)::text, count(*)::text
  FROM pg_policies
  WHERE schemaname='public' AND tablename IN ('sales_orders','order_items','sales_price_history')
    AND COALESCE(qual, with_check) NOT ILIKE '%select%'
)
SELECT n, ok, descricao, valor FROM checks ORDER BY n;
