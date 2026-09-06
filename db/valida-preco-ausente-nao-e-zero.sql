-- Validação pós-apply de 20260905225613_preco_ausente_nao_e_zero.sql (read-only).
-- Cada linha é um OBJETO da migration. Tudo ✅ = aplicou; qualquer ❌ = não pegou.
WITH d AS (SELECT pg_get_functiondef(p.oid) AS src, n.nspname AS ns, p.proname AS nome
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prokind = 'f')
SELECT 'A. unit_price aceita NULL' AS objeto,
       CASE WHEN (SELECT is_nullable FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='order_items' AND column_name='unit_price') = 'YES'
            THEN '✅' ELSE '❌' END AS ok
UNION ALL SELECT 'A. unit_price sem DEFAULT',
       CASE WHEN (SELECT column_default FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='order_items' AND column_name='unit_price') IS NULL
            THEN '✅' ELSE '❌' END
UNION ALL SELECT 'B. criar_pedidos_com_itens: régua nova',
       CASE WHEN (SELECT src FROM d WHERE ns='public' AND nome='criar_pedidos_com_itens')
                 LIKE '%(it->>''unit_price'')::numeric >= 0%' THEN '✅' ELSE '❌' END
UNION ALL SELECT 'C. reconciliar_pedidos_omie: diff NULL-safe',
       CASE WHEN (SELECT src FROM d WHERE ns='public' AND nome='reconciliar_pedidos_omie')
                 NOT LIKE '%abs(coalesce(a.unit_price, 0) - d.unit_price)%' THEN '✅' ELSE '❌' END
UNION ALL SELECT 'D. margem_cliente_agregada: preço > 0',
       CASE WHEN (SELECT src FROM d WHERE ns='private' AND nome='margem_cliente_agregada')
                 LIKE '%preco_unit > 0%' THEN '✅' ELSE '❌' END
UNION ALL SELECT 'D/E. as duas funções de margem devolvem 8 colunas',
       CASE WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
                       unnest(p.proargmodes) m
                  WHERE m='t' AND p.prokind='f'
                    AND ((n.nspname='private' AND p.proname='margem_cliente_agregada')
                      OR (n.nspname='public'  AND p.proname='get_customer_margin_summary'))) = 16
            THEN '✅' ELSE '❌' END
-- ACL pelo OID, não pelo nome textual: resolver 'private.f()' como texto exige USAGE no
-- schema, e o papel de leitura (claude_ro) não o tem — a query falharia por permissão em vez
-- de responder. Pelo OID ela roda igual no SQL Editor e no psql-ro.
UNION ALL SELECT 'ACL: anon/authenticated FORA da margem (o DROP reseta!)',
       CASE WHEN NOT EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE p.prokind='f'
                 AND ((n.nspname='private' AND p.proname='margem_cliente_agregada')
                   OR (n.nspname='public'  AND p.proname='get_customer_margin_summary'))
                 AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                   OR has_function_privilege('authenticated', p.oid, 'EXECUTE')))
            THEN '✅' ELSE '❌ ABRIU CUSTO AGREGADO — avise já' END
UNION ALL SELECT 'ACL: service_role DENTRO (a edge calculate-scores depende)',
       CASE WHEN (SELECT bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE p.prokind='f'
                     AND ((n.nspname='private' AND p.proname='margem_cliente_agregada')
                       OR (n.nspname='public'  AND p.proname='get_customer_margin_summary')))
            THEN '✅' ELSE '❌' END
UNION ALL SELECT 'F. melhoria_clientes_por_produto: ranking NULLS LAST',
       CASE WHEN (SELECT src FROM d WHERE ns='public' AND nome='melhoria_clientes_por_produto')
                 LIKE '%valor_12m desc nulls last limit 50%' THEN '✅' ELSE '❌' END
UNION ALL SELECT 'G. get_defasagem_cliente: média não diluída',
       CASE WHEN (SELECT src FROM d WHERE ns='public' AND nome='get_defasagem_cliente')
                 LIKE '%sum(quantity) FILTER (WHERE unit_price > 0)%' THEN '✅' ELSE '❌' END;
