-- ⚠️ DESTINO: 🟣 SQL Editor do Lovable (colar → Run). NÃO é auto-aplicada. NÃO vai em supabase/migrations/
--    (essa pasta é a fonte de DR — o Lovable a materializa após o apply). Registro versionado + fonte do
--    bloco de handoff. Prova: db/test-omie-customer-account-map-fresco.sh (PG17, falsificação).
--
-- P1a (staleness) — view FRESCA sobre omie_customer_account_map. Fecha o débito do syncCustomers
-- (upsert-only nunca invalida row órfã) levantado pelo Codex no PR #1260. Os 2 consumidores de LEITURA
-- (src/components/customer360/hooks.ts useCustomerPreferredItems, supabase/functions/compare-customer-process)
-- leem ESTA view, não a tabela: a invariante de frescor vive PERTO DO DADO (não duplicada na UI) e usa
-- now() do BANCO (elimina clock-skew de new Date() no browser — furo 6d do Codex).
--
-- CONTRATO: updated_at desta tabela = "última vez que o sync VIU a linha no Omie". O writer syncCustomers
-- refresca updated_at a cada run que vê a linha (upsert); NÃO há trigger na tabela (psql-ro 2026-07-09:
-- pg_trigger=0; 15669/15669 linhas com updated_at>created_at). Válido enquanto o sync (edge service_role)
-- for o ÚNICO writer — se surgir 2º writer / edição manual (source='manual'), promover coluna dedicada
-- last_seen_sync_at (NÃO antes; Codex P2). Threshold 7d = 7 runs do cron diário de folga (o
-- data_health_watchdog grita "sync parado" muito antes).
-- Design: docs/superpowers/specs/2026-07-09-omie-proof-table-staleness-doc-ambiguo-design.md

CREATE OR REPLACE VIEW public.omie_customer_account_map_fresco
WITH (security_invoker = true) AS
SELECT id, user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, created_at, updated_at
FROM public.omie_customer_account_map
WHERE updated_at >= now() - interval '7 days';

-- security_invoker=true é OBRIGATÓRIO: a view roda com os privilégios do CHAMADOR → a RLS da tabela base
-- se aplica (staff ALL, user vê próprio). Sem isso a view rodaria como owner e BYPASSARIA a RLS (vazamento).
-- GRANT espelha a base: authenticated/anon têm SELECT, mas a RLS herdada nega anon (sem policy) → 0 linhas.
GRANT SELECT ON public.omie_customer_account_map_fresco TO authenticated, anon;
