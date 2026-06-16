# Runbook — rebuild funcional a partir do snapshot de schema

Complemento do **`supabase/schema-snapshot.sql`** (#244/#247), que é o retrato `--schema=public` de produção mas **não cobre a infra fora de `public`** nem ensina o rebuild funcional. Este runbook + `supabase/schema-infra-outside-public.sql` + `supabase/schema-security-report.md` fecham essa lacuna (a "captura funcional completa" que o `README-schema.md` deferiu).

> ⚠️ Produção NÃO é tocada por nada aqui. Isto é só pra reconstruir um ambiente **novo** (staging/DR/onboarding).

## ⛔ O que NUNCA fazer
- **Não mover o snapshot pra `supabase/migrations/`** nem arquivar as migrations de lá — o Lovable é dono operacional do backend e a pasta é reconhecida pelo ecossistema Lovable/Supabase (decisão pós-codex; risco de confundir builder + tracking `schema_migrations`).
- **Não aplicar o snapshot em produção existente** nem rodar `supabase db push` dele contra prod (recriaria objetos / divergiria o tracking).

## Ordem do rebuild (num projeto Supabase NOVO e vazio)
1. **Prelude:** `supabase/schema-extensions-prelude.sql` (extensions de DDL: uuid-ossp/pgcrypto/pg_trgm em `extensions`, `vector` em `public`; `pg_cron` fica a habilitar pelo dashboard).
2. **Schema:** `supabase/schema-snapshot.sql` via `psql` (ver armadilhas no `README-schema.md`: remover `CREATE SCHEMA public;` sem IF NOT EXISTS, remover `\restrict`/`\unrestrict`; não usar `pg_restore`).
3. **Infra fora de `public`:** `supabase/schema-infra-outside-public.sql` (buckets + realtime publication — idempotente).
4. **Vault:** criar o secret **`CRON_SECRET`** no Vault do projeto novo (NUNCA o valor real no repo).
5. **Crons:** recriar (ver §abaixo).
6. **Plataforma (dashboard):** habilitar `pg_cron`, `pg_net`, `pg_stat_statements`, `supabase_vault` se ainda não estiverem.

## Recriar os 33 crons (env-specific)
Não vão hardcoded no repo (têm URL do projeto + secrets). No projeto de ORIGEM, exportar:
```sql
SELECT 'SELECT cron.schedule(' || quote_literal(jobname) || ', ' || quote_literal(schedule) || ', ' || quote_literal(command) || ');' AS stmt
FROM cron.job ORDER BY jobname;
```
No projeto NOVO: trocar `https://<REF_ANTIGO>.supabase.co` pela URL nova, e o **JWT anon hardcoded** do cron `sayerlack-portal-watchdog` pelo anon key novo (ver `schema-security-report.md`). Colar no SQL Editor.

Inventário (jobname / schedule):

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

## Verificação de replay
**Replay sintático/ordem validado em 2026-05-24** via `db/verify-snapshot-replay.sh` (Postgres 17 local + `db/stubs-supabase.sql`): prelude + stubs + snapshot em transação única (`ON_ERROR_STOP`) rodaram limpo e as contagens batem 1:1 com produção (212/37/4/86/76/14/474). Níveis:
- **Gold (pendente):** rodar a sequência num projeto Supabase vazio (provê `auth`/roles/extensions reais). Sem docker nesta máquina pra `supabase start`.
- **Sintaxe/ordem (FEITO):** `db/verify-snapshot-replay.sh` — Postgres + stub de roles (`anon`/`authenticated`/`service_role`) + schema `auth` (`auth.uid()`/`auth.role()`) + extensions. Prova ordem/dependência do `public`, não o comportamento de plataforma. ⚠️ O script contorna percalços do brew keg-only (popula share/lib do postgresql@17 a partir do Cellar; módulos `.dylib`; `LC_ALL=C` senão o postmaster aborta).
- Garantir `search_path` do banco incluindo `extensions` (default Supabase) — funções com `similarity()` não-qualificado dependem disso (ver security report).

## Se o Lovable criar drift de novo
Re-gerar o `schema-snapshot.sql` pelo prompt do `README-schema.md`, atualizar o manifest (o diff do git é a revisão do drift), e re-conferir a infra fora de `public` (rodar as queries de captura do design em `docs/superpowers/specs/2026-05-24-baseline-squash-schema-design.md`).
