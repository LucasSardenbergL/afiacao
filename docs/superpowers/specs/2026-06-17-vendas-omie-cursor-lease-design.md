# Sync de pedidos Omie — cursor + lease (backfill confiável) — Design

> **Origem:** candidato #2 do diagnóstico de skills (sessão 2026-06-17). A ideia inicial era uma *skill de backfill serializado* (gera fila temp + cron `*/6` + valida por contagem). O **Codex (consult, 2026-06-17)** matou esse design: *"para money-path, cron `*/6` + contagem é heurística, não serialização. O risco dominante é você produzir um backfill que parece completo, mas perdeu páginas ou contaminou score/OTE."* O gap real **não é boilerplate SQL — é infraestrutura no edge.** Este spec descreve o conserto certo.
>
> **Money-path crítico:** mexe em `sales_orders`/`order_items` → positivação/OTE/comissão dos farmers. Erro de 1 mês = ~R$80k de comissão errada (precedente, `programas-vendas.md`).
>
> **Escopo desta sessão:** SÓ o design (este arquivo). A implementação toca o edge `omie-vendas-sync` (money-path) → **sessão fresca**, com `prove-sql-money-path` + `/codex challenge` + deploy manual.

## 1. Problema

Backfill de pedidos = puxar histórico do Omie, página a página, por conta. Hoje é um ritual manual (fila temp + cron + validação por contagem — `sync.md`, backfill Oben). Três defeitos estruturais **no edge** tornam qualquer automação em cima disso perigosa:

1. **`null` ambíguo** — `callOmieVendasApi` retorna `null` tanto para "página vazia/fim" quanto para "rate-limit/erro transitório esgotado". O loop de paginação trata os dois como fim → **pode parar no meio achando que acabou**.
2. **Sem serialização real** — a única defesa contra invocação concorrente (que o Omie pune com rate-limit silencioso) é o *intervalo* do cron. Mas a edge roda em background além do timeout (`sync_pedidos` ~40s/página + lookups de cliente = 4-7 min/mês), então o cron re-dispara **enquanto a anterior ainda roda** → concorrência → rate-limit → o defeito #1 de volta.
3. **Insert-only sem completude confiável** — valida por contagem no banco, que só prova *crescimento*, não *completude*.

## 2. Estado atual (empírico — código, 2026-06-17)

| Fato | Onde |
|---|---|
| O edge JÁ distingue rate-limit (`OMIE_TRANSIENT`) de "Não existem registros para a página", mas **colapsa ambos em `null`** no retorno | [`callOmieVendasApi`](../../../supabase/functions/omie-vendas-sync/index.ts) `index.ts:276-285` |
| Existe `throwOnTransient` que faz o transitório-esgotado virar **throw** (distinguível) — mas o comentário admite *"syncs paginados continuam tratando null como fim"* (não é usado no loop) | `index.ts:228-233` |
| Insert-only por `hash_payload = omie_<account>_<codigoPedido>`: pula existentes, **não atualiza pedido alterado/cancelado** | `index.ts:943, 1137` |
| `fin_sync_log` é **best-effort** (telemetria, não lock) | `index.ts:1657` |
| Padrão de cursor persistido já existe no financeiro: `(company, resource, next_page)`, `next_page NULL = completo`, cron de continuação `*/10` — **mas sem `lease`/heartbeat** | [`fin_sync_cursor.sql`](../../../supabase/migrations/20260525020000_fin_sync_cursor.sql) |
| `order_items.created_at` não é setado pelo sync → `DEFAULT now()` → backfill antigo parece "comprado hoje" → score/positivação errados | `sync.md`, `programas-vendas.md` |

**Leitura:** a infra de distinção (`throwOnTransient`) e o molde de cursor (`fin_sync_cursor`) já existem. Falta (a) **usar** o discriminador no loop e (b) **lease/heartbeat** no cursor. O conserto é menor do que parecia.

## 3. Decisões (founder 2026-06-17 + Codex)

| Decisão | Escolha |
|---|---|
| Alcance | **Só pedidos/vendas** (`sales_orders`/`order_items`). NFe/financeiro fora. |
| Profundidade | **Ritual fim-a-fim**, mas a confiabilidade vem do edge (cursor/lease), não de contagem. |
| Escopo do conserto | **A — cursor + lease + `null`-discriminado, mantendo insert-only.** Pedido alterado/cancelado vira **relatório de divergência** (humano decide), **não** auto-reconciliação. |
| Auto-reconciliação (upsert de valor/status) | **Fase 2.** Auto-mexer no valor de um pedido = comissão sem humano = o que o Codex listou como "nunca automatizar". |
| Quem executa | Escrita (migration/cron/fila) = **humano cola** no SQL Editor. Monitoramento/relatórios = **eu via `psql-ro`** (read-only). |

## 4. Desenho

### 4.1 Edge `omie-vendas-sync` — usar o discriminador + cursor + lease
- **Loop de paginação de `sync_pedidos` passa a usar `throwOnTransient: true`.** Resultado: `null` ⟹ "Não existem registros" ⟹ **fim real**; `throw OMIE_TRANSIENT` ⟹ rate-limit/erro ⟹ **pausa** (grava `last_error_kind`, NÃO marca completo).
- **Lê o cursor** no início (de onde retomar: `next_page`). **Grava** progresso por página (`next_page`, `heartbeat_at`); ao terminar a janela limpa `running_since`, e se `null`-fim seta `completed_at` + `next_page=NULL`.
- **Lease atômico** (serialização real, substitui o "intervalo de cron"): antes de processar, `UPDATE … SET running_since=now(), heartbeat_at=now() WHERE pk=… AND (running_since IS NULL OR heartbeat_at < now() - interval '3 min')`. **0 linhas afetadas ⟹ outra invocação viva ⟹ sai (no-op).** Heartbeat por página renova o lease; lease "morto" (heartbeat velho) é retomável.
- ⚠️ **Requer redeploy do edge** (como o `fin_sync_cursor` exigiu do `omie-financeiro`). Sem ele, a tabela fica ociosa e o edge degrada pro comportamento atual.

### 4.2 Migration — `vendas_sync_cursor`
```
(account text, date_from date, date_to date,
 next_page int,              -- NULL = sem resume pendente
 completed_at timestamptz,   -- NULL até a janela fechar de verdade
 last_error_kind text,       -- null | rate_limit | transient | http
 running_since timestamptz,  -- NULL = livre (lease)
 heartbeat_at timestamptz,   -- renovado por página (detecta lease morto)
 PRIMARY KEY (account, date_from, date_to))
```
+ RLS (staff lê, `service_role` escreve — espelha `fin_sync_cursor`) + índice parcial `WHERE next_page IS NOT NULL OR completed_at IS NULL` (cron varre só pendentes) + cron de continuação (`*/6`, dispara `net.http_post` por janela pendente, `timeout_milliseconds := 150000`; contas distintas = paralelas, mesma conta = serializada pelo lease).

### 4.3 Orquestração de backfill (a skill/runbook fina por cima)
1. **Semear** (humano cola): `INSERT` 1 linha de cursor por janela mensal da conta (eu calculo as janelas via `psql-ro` olhando o gap).
2. **Rodar**: o cron de continuação avança sozinho até `completed_at` em todas; eu **monitoro o cursor real** via `psql-ro` (não contagem) — ETA por cadência observada.
3. **Fecho money-path** (humano cola + eu valido), **nesta ordem**: corrigir recência (§5.4) → `REFRESH customer_metrics_mv` → religar crons de score (§5.5). Eu valido os relatórios (§4.4) ANTES de liberar.

### 4.4 Relatórios (eu, `psql-ro`, read-only)
- **Outlier** (§5.6): regra + top-N, humano revisa.
- **Cobertura**: contagem por janela vs esperado; gaps de páginas (cursor que parou com `last_error_kind` ≠ null e não completou).
- **Integridade**: pedido sem cliente/item, `order_date_kpi` nulo/sujo.
- *(Divergência ativa banco-vs-Omie — re-consultar o Omie pra achar cancelados — é caro e fica na **fase 2** com a reconciliação.)*

## 5. Guards money-path (os 8 pontos do Codex viram requisitos)
1. **Serialização real** via lease/heartbeat atômico no banco — não intervalo de cron (#1).
2. **Completude confiável** via `completed_at` + `null`-discriminado — não contagem (#2).
3. **Insert-only + relatório** — não auto-reconcilia valor/status (#3).
4. **Recência cirúrgica**: `UPDATE order_items.created_at = so.order_date_kpi … WHERE so.hash_payload LIKE 'omie_<account>_%' AND oi.created_at >= <backfill_started_at> AND so.order_date_kpi IS NOT NULL` — **só os backfillados**, com `RETURNING`/amostra antes do commit humano. Nunca toca pedido manual/legítimo (#4).
5. **Crons de score pausam no início**: snapshot (nome+schedule) → `unschedule` → religar só após recência+MV+outlier (#5).
6. **Outlier por regra**, não threshold mágico: `total > limite_absoluto_por_empresa OR total > p99_180d * mult`, + top-N por mês/cliente/vendedor, + revisão humana dos maiores (#6).
7. **Gates humanos** (§6) (#7).
8. **Cursor/lease é a fundação** — sem ele, nada acima é confiável (#8).

## 6. Gates humanos — NUNCA automático (Codex #7)
Cria/agenda fila e cron · pausa/religa crons de score · `UPDATE created_at` · correção/cancelamento de outlier · `REFRESH` e liberação final · a decisão "backfill completo". **O agente gera evidência (read-only); o humano cola/aprova.**

## 7. Decomposição (ordem de construção)
- **Sub-projeto 1 (fundação):** migration `vendas_sync_cursor` + edge usa `throwOnTransient` + lê/grava cursor + lease. Prova: `prove-sql-money-path` (cursor/lease/idempotência) + teste do edge em sandbox.
- **Sub-projeto 2 (orquestração):** runbook de semear/monitorar/fechar + relatórios `psql-ro` + recência cirúrgica + pausa/religa de scores.
- **Sub-projeto 3 (fase 2, adiada):** auto-reconciliação (upsert de pedido alterado) + divergência ativa banco-vs-Omie.

## 8. Testes
- **`prove-sql-money-path` (PG17 local, falsificável):** lease atômico (2 "invocações" concorrentes → só 1 processa) · cursor retoma do `next_page` · `completed_at` só com `null`-fim · recência cirúrgica não toca pedido fora da janela/manual · outlier dispara na regra. Cada um **falsificado** (sabotar → vermelho).
- **Edge:** testar `throwOnTransient` no loop com mock de rate-limit (throw=pausa) vs página-vazia (null=fim).

## 9. Riscos e limites conhecidos
- **Deploy do edge é manual** (Lovable, verbatim da main) — coordenar com `lovable-deploy-verify`.
- **Lease morto por crash**: heartbeat velho é retomável (3 min) — risco de retomar uma invocação que ainda vai gravar (janela de 3 min). Mitigação: heartbeat frequente; aceitar reprocesso (insert-only é idempotente).
- **Fase 2 explícita**: pedido alterado/cancelado no Omie **não** é corrigido na fase 1 (só relatado). O caso R$615M é pego pelo outlier (humano corrige na fonte).

## 10. Plano de implementação (alto nível — sessão fresca)
1. Migration `vendas_sync_cursor` (via `lovable-db-operator`) → `prove-sql-money-path`.
2. Edge: `throwOnTransient` no loop + cursor + lease → `/codex challenge` → deploy manual → verificar (`lovable-deploy-verify`).
3. Cron de continuação (migration).
4. Runbook de orquestração + relatórios `psql-ro`.
5. Piloto: backfill de **1 mês pequeno** de 1 conta → validar cobertura/recência/outlier antes de qualquer janela grande.
