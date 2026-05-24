# Baseline Manifest — o que o baseline cobre e o que é Supabase-managed

**Gerado:** 2026-05-24 · **Fonte:** `pg_dump --schema-only --schema=public` de produção (`fzvklzpomgnyikkfkzai`) via chat do Lovable.
**Arquivo baseline:** `db/baselines/2026-05-24_prod_schema_baseline.sql` (⚠️ **fora** de `supabase/migrations/` — decisão pós-codex; ver runbook). Tag git: `schema-baseline-prod-2026-05-24`. Regerar: `db/build-baseline.sh`.

## No baseline (núcleo `public`)
212 tabelas · 37 views (34 com `security_invoker`) · 4 matviews · 86 funções nossas · 76 triggers · 474 policies · 38 sequences · 14 enums · índices · GRANTs/REVOKEs · RLS `ENABLE`.
+ **4 extensions de dependência de DDL** (injetadas após `CREATE SCHEMA public`): `uuid-ossp`, `pgcrypto`, `pg_trgm` (em `extensions`), `vector` (em `public`).
+ **6 storage buckets** (idempotente, `ON CONFLICT DO NOTHING`).
+ **publication `supabase_realtime`** com 10 tabelas (`eventos_outlier`, `farmer_calls`, `nfe_recebimentos`, `order_messages`, `orders`, `pedido_compra_sugerido`, `picking_tasks`, `sales_orders`, `sku_parametros`, `tint_importacoes`).

## Fora do baseline — gerenciado pela plataforma Supabase
Habilitar via dashboard/projeto Supabase ANTES de rodar crons/uploads:
- **Extensions de plataforma:** `pg_cron` (pg_catalog), `pg_net` (extensions), `pg_stat_statements` (extensions), `supabase_vault` (vault). *(Não criadas no baseline: funções que as referenciam criam OK por `check_function_bodies=false`; só precisam existir em runtime.)*
- **Roles:** `anon`, `authenticated`, `service_role`, `postgres`, `supabase_admin` — providos pelo Supabase.
- **Schemas:** `auth`, `storage`, `realtime`, `vault`, `graphql`, `extensions` — providos pelo Supabase.
- **Vault secrets necessários:** `CRON_SECRET` (usado por ~30 crons). Criar no Vault do projeto alvo (NUNCA commitar o valor).

## Crons (33) — recriar por-ambiente (ver runbook)
Não vão no baseline (env-specific: URL do projeto + secret no vault). Recriar via `SELECT cron.schedule(...)` substituindo `https://fzvklzpomgnyikkfkzai.supabase.co` pela URL do ambiente alvo. Inventário (jobname / schedule):

| jobname | schedule | | jobname | schedule |
|---|---|---|---|---|
| afiacao_ciclo_oportunidade_diario | `5 11 * * *` | | omie-sync-estoque-diario | `0 9 * * *` |
| afiacao_dispatch_notificacoes_diario | `10 11 * * *` | | omie-sync-metadados-daily | `30 8 * * *` |
| afiacao_estados_eventos_diarios | `0 11 * * *` | | omie-sync-status-produtos-diario | `30 6 * * *` |
| afiacao_limpeza_sugestoes_mensal | `0 6 1 * *` | | process-recurring-orders-daily | `0 7 * * *` |
| afiacao_omie_oben_sku_items_history_daily | `0 7 * * *` | | sayerlack-portal-watchdog | `*/5 * * * *` |
| afiacao_omie_oben_sync_incremental_2h | `15 */2 * * *` | | scoring-recalc-batch-nightly | `0 6 * * *` |
| afiacao_ranking_refresh_semanal | `0 10 * * 1` | | sync-colacor-vendas-products | `15 6 * * *` |
| afiacao_sugestoes_diarias | `0 10 * * *` | | sync-inventory-vendas-30m | `*/30 * * * *` |
| call-log-missed-backstop | `* * * * *` | | sync-omie-services-hourly | `0 * * * *` |
| compute-association-rules-daily | `30 7 * * *` | | sync-orders-vendas-2h | `0 */2 * * *` |
| compute-costs-daily | `0 7 * * *` | | sync-products-customers-daily | `0 6 * * *` |
| daily-calculate-scores | `0 6 * * *` | | sync-reprocess-operational | `15 */2 * * *` |
| detectar-outliers-diario | `30 7 * * *` | | sync-reprocess-strategic | `30 2 * * *` |
| disparar-pedidos-aprovados-oben | `0 13 * * *` | | visit-score-recalc-batch-nightly | `0 7 * * *` |
| fin-cashflow-snapshot-diario | `0 10 * * *` | | weekly-algorithm-a-audit | `0 3 * * 0` |
| fin-ic-reconcile-daily | `0 9 * * *` | | gerar-pedidos-diario-oben | `15 9 * * *` |
| monthly-tool-report | `0 9 1 * *` | | | |

## Discrepâncias dump vs `pg_proc`/`pg_indexes` (esperadas, não são gap)
- **Funções 86 (dump) vs 204 (`pg_proc` public):** diferença ≈ funções da extension `vector` (instalada em `public`) — recriadas pelo `CREATE EXTENSION vector`.
- **Índices 230 (`CREATE INDEX`) vs 532 (`pg_indexes`):** diferença = índices de PK/UNIQUE (pg_dump emite como `ALTER TABLE ADD CONSTRAINT`, não `CREATE INDEX`) + índices da extension.

## Runtime: `search_path` precisa incluir `extensions` (default do Supabase)
Há funções com `SET search_path TO 'public', 'pg_temp'` que chamam `pg_trgm` **não-qualificado** (ex: `similarity(...)`), mas `pg_trgm` está no schema `extensions`. Em produção isso funciona porque o Supabase configura o `search_path` do banco/role incluindo `extensions`. **No ambiente alvo (staging/DR), garantir o mesmo** (`ALTER DATABASE ... SET search_path = public, extensions` — Supabase já faz por padrão). É estado fiel à produção, não introduzido pelo baseline — registrado no security report como latente.

## Encoding
Dump veio com `client_encoding = 'SQL_ASCII'`; baseline usa `UTF8` (corpo tem `→` e acentos pt-BR).
