# Recência da `customer_metrics_mv` por data do pedido (`order_date_kpi`) — design

> Fase 2b do sub-projeto 2 (vendas/recência Omie). Money-path. Codex challenge xhigh em 2026-06-23.
> Substrato: `docs/historico/programas-vendas.md` (Fase 2b, "conserto de fonte").

## Problema

A `customer_metrics_mv` deriva recência (`dias_desde_ultima_compra`, `ultima_compra_data`),
cadência (`intervalo_medio_dias`) e janelas de faturamento (`pedidos_90d`, `faturamento_90d`,
`faturamento_prev_90d`) de **`sales_orders.created_at`**. O edge `omie-vendas-sync` grava
`created_at = data_previsao` (previsão de **entrega**) ou `now()` — **não** `dInc` (data de
inclusão do pedido = data real). A coluna canônica `sales_orders.order_date_kpi date` (= dInc)
já existe e está populada.

**Evidência (prod, `psql-ro`):** Oben 1786/10169 pedidos (17,6%) com `created_at::date ≠ order_date_kpi`,
`created_at` quase sempre **depois** (1782/1786), mediana 2d, cauda até 736d → recência enviesada
"mais recente que a verdade". Colacor já 100% alinhado (migration `20260618130000`). `order_date_kpi`
nulo em só **3** pedidos Oben, 0 colacor.

A MV alimenta money-path: fila de ligação D-1 (`useRouteContactList`), `ai-ops-agent` (gera
`ai_decisions`, thresholds 45/60/90 dias), Customer360, Crítica da Fila — todos herdam a recência errada.

## Decisão (aprovada pelo founder + Codex)

**Consertar os consumidores, não a fonte.** O caminho autoritativo do scoring
(`get_customer_sales_summary` → `calculate-scores` → `farmer_client_scores`) **já** usa
`max(COALESCE(so.order_date_kpi, so.created_at::date))`; o cockpit financeiro também já migrou.
Só a MV e o hook display-only `useFarmerScoring` ficaram para trás.

- **NÃO mexer no edge** (`created_at` fica como está) — evita o gate **#B** (o cron `sync-reprocess`
  reescreve `hash_payload` e re-poluiria a Oben) e o re-sujar a cada sync. Aposenta o patch manual.
- **Migrar a MV inteira** (recência + cadência + janelas) para a base de data canônica.
- **Escopo travado = só DATA.** Alinhar status/`deleted_at`, `so.total`-vs-`order_items`, e a camada
  DRY comum são **follow-ups** (ver abaixo) — não arrastar (isola a variável p/ prova limpa).

## Design da MV (pós-Codex)

Base de data canônica por linha, **timezone explícito** (determinístico sob qualquer TZ de sessão):

```
d        := COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date)   -- date
today_sp := (now() AT TIME ZONE 'America/Sao_Paulo')::date
```

- `last_order`: `ultima_compra_data = (max(d)::timestamp AT TIME ZONE 'America/Sao_Paulo')` (meia-noite
  SP como `timestamptz` — **preserva o tipo** exigido por `get_customer_metrics`);
  `dias_desde_ultima_compra = GREATEST(0, today_sp - max(d))::int`.
- `orders_90d`: `WHERE d >= today_sp - 90 AND d <= today_sp` (**teto** fecha previsão futura dos nulos).
- `orders_prev_90d`: `WHERE d >= today_sp - 180 AND d < today_sp - 90` (sem overlap em D-90).
- `cadence`: `((max(d) - min(d))::numeric / NULLIF(count(*)-1, 0))` (**cast numeric**, não trunca).
- Demais colunas (`atraso_relativo`, `is_cold_start`, `calculated_at`, `razao_social`, `document`)
  **idênticas** — preservar as 13 colunas em ordem e tipo (contrato de `get_customer_metrics`).

**Migration transacional** (fecha a janela de runtime quebrado da RPC late-bound):

```sql
BEGIN;
  DROP MATERIALIZED VIEW IF EXISTS public.customer_metrics_mv;
  CREATE MATERIALIZED VIEW public.customer_metrics_mv AS ...;          -- popula
  CREATE UNIQUE INDEX idx_customer_metrics_mv_uid ON public.customer_metrics_mv (customer_user_id);
  GRANT SELECT ON public.customer_metrics_mv TO service_role;          -- authenticated/anon ficam sem (como hoje)
COMMIT;
```

Índice **normal** (não `CONCURRENTLY` — a MV nasce populada). `refresh_customer_metrics()` e
`get_customer_metrics()` sobrevivem (late-bound, mesmos nomes/colunas).

## Hook `useFarmerScoring.ts` (display-only)

`select('... created_at ...')` → adicionar `order_date_kpi`; `orderTime` passa a
`new Date(order.order_date_kpi ?? order.created_at)`. Recompute orgânico; sem escrita.

## Codex challenge xhigh — triagem (7 P1 / 7 P2)

**Incorporados:** teto/sem-overlap nas janelas; `AT TIME ZONE 'America/Sao_Paulo'` em `ultima_compra_data`
e no fallback `created_at`; cast `numeric` na cadência; DROP+CREATE numa transação.
**Separados (follow-up):** status/`deleted_at` (universo); `so.total` vs `order_items` (contrato financeiro);
camada DRY `valid_sales_orders_kpi` (regra COALESCE hoje em MV+RPC+cockpit); a RPC `get_customer_sales_summary`
usa `created_at::date` cru (mesmo bug latente de borda — corrigir lá depois).
**Harness de prova:** borda 90d com `today_sp` fixo perto de meia-noite UTC (D-90/91/180/181/D/D+1,
`kpi≠created_at`); **rodar sob `SET TIME ZONE 'UTC'` e `'America/Sao_Paulo'` exigindo resultados idênticos**;
assert pré-apply dos 3 nulos; diff por cliente antes do apply.

## Prova (prove-sql-money-path, PG17) — ✅ 31/0 VERDE

`db/test-recencia-mv-order-date-kpi.sh` aplica a migration REAL e prova: 14 positivos (recência por
`order_date_kpi`, COALESCE nos nulos, teto/sem-overlap das janelas, clamp do futuro, cadência numeric,
`ultima_compra_data` meia-noite SP, EMP/cancelado fora), contrato late-bound (`get_customer_metrics()` roda +
`ultima_compra_data` timestamptz), GRANT (service_role ok / authenticated 42501), anti-TZ (UTC×SP idênticos),
e **7 falsificações com dente** (F1 order_date_kpi · F2 AT TIME ZONE · F3 teto · F4 cast numeric · F5 TZ no
fallback · F6 sem-overlap · F7 contrato).

**Achado do F7 (lição durável):** mudar `ultima_compra_data` para `date` **NÃO** quebra `get_customer_metrics`
— o Postgres **coage `date`→`timestamptz` silenciosamente**. A coerção usa a TZ da **sessão da RPC**, reintroduzindo
não-determinismo de forma SILENCIOSA (pior que quebra dura). Por isso a MV produz `(max(d)::timestamp AT TIME ZONE
'America/Sao_Paulo')` — preservar o tipo **com** o TZ explícito é o que blinda, não só o tipo.

## Handoff (deploy manual Lovable)

- **Migration:** colar a transação no SQL Editor → Run → `REFRESH MATERIALIZED VIEW CONCURRENTLY` (ou o
  `CREATE AS` já popula). Validar `pg_get_viewdef` + diff por cliente via `psql-ro`.
- **Hook:** frontend → **Publish** no editor do Lovable.

## Follow-ups (fora desta fase)

1. Alinhar universo MV↔RPC (status `pendente`/`orcamento`, `deleted_at`) — quantificar o degrau.
2. `faturamento` por `order_items` (paridade com a RPC).
3. Camada DRY `valid_sales_orders_kpi` consumida por MV+RPC+cockpit.
4. ✅ **FEITO** — migration `20260623150000_get_customer_sales_summary_tz_fallback` (v5, `CREATE OR REPLACE` preservando a blocklist v4): `created_at::date` → `(created_at AT TIME ZONE 'America/Sao_Paulo')::date` nas 2 ocorrências (recência `max` + janela `revenue_180d`). Prova PG17 `db/test-get-customer-sales-summary.sh` **38/0** (anti-TZ UTC×SP idêntico nas 2 ocorrências + falsificação FTZ com dente). Impacto prático hoje = 0 (psql-ro: 0 pedidos `order_date_kpi`-nulo no universo da RPC) → defensivo. Aguarda apply manual no SQL Editor.
