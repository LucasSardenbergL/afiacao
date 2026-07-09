-- PR0.0-bis (B de 2) — Fecha a leitura de omie_payload/omie_response de sales_orders.
--
-- ⚠️  APLICAR SÓ DEPOIS de: (1) a migration A aplicada (a RPC staff_get_sales_order_payload
--     precisa existir) E (2) o Publish do front migrado (que já usa a RPC e NÃO faz mais
--     `.select('*')` de sales_orders). O REVOKE abaixo derruba QUALQUER `.select('*')` vigente,
--     e o staff É 'authenticated' — aplicar antes do Publish quebra edição/impressão/cotação
--     do staff no intervalo. (Ver o cabeçalho da migration A para a sequência completa.)
--
-- Achado que dá a forma (psql-ro, prod): 'authenticated' tem SELECT *table-level* (relacl
-- arwdDxtm). REVOKE de UMA coluna é NO-OP enquanto o table-level existe. Por isso: REVOKE SELECT
-- (table) + GRANT SELECT das 25 colunas NÃO-sensíveis. omie_payload/omie_response ficam de fora.
-- ⚠️  Coluna NOVA em sales_orders nasce SEM grant p/ 'authenticated' (some do PostgREST): conceder
--     explicitamente. NUNCA reemitir `GRANT SELECT ON public.sales_orders TO authenticated` (table)
--     — reabre o vazamento de payload/response.
--
-- Idempotente: REVOKE/GRANT são seguros de re-colar no SQL Editor.

BEGIN;

-- authenticated: troca o SELECT table-level por SELECT das 25 colunas não-sensíveis.
REVOKE SELECT ON public.sales_orders FROM authenticated;

GRANT SELECT (
  id, customer_user_id, created_by, items, subtotal, discount, total, status, notes,
  omie_pedido_id, omie_numero_pedido, created_at, updated_at, account, hash_payload,
  customer_address, customer_phone, ready_by_date, deleted_at, order_date_kpi,
  checkout_id, origem, atendimento_id, pedido_programado_envio_id, customer_document
) ON public.sales_orders TO authenticated;

-- anon: defense-in-depth (Codex xhigh P2). Não há path de leitura anon hoje (a RLS de
-- sales_orders é TO authenticated → anon lê 0 linhas), mas anon tinha SELECT table-level
-- (arwdDxtm) — o mesmo hazard F1: uma futura policy anon ou surface invoker reabriria payload.
-- anon não deve ler NADA de sales_orders (sempre pós-login) → REVOKE sem GRANT de volta.
REVOKE SELECT ON public.sales_orders FROM anon;

COMMIT;
