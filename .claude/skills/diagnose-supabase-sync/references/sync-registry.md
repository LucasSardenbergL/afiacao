# Registry dos syncs — o que existe, e como provar o efeito de cada um

Sem ancorar no sync certo, o `net._http_response` é ambíguo (65 crons compartilham minuto/endpoint). Este registry tem os **money-path críticos** curados + a query que **re-deriva do banco ao vivo** (a lista muda; não confie só nesta tabela).

## Derive a lista atual do banco (faça isto primeiro)

```bash
RO=~/.config/afiacao/psql-ro
# crons ativos (65 no total em 2026-06)
$RO -c "select jobname, schedule from cron.job where active order by jobname;"
# quais syncs logam em fin_sync_log (= rastreáveis por camada) e o frescor de cada um:
$RO -c "select action, max(started_at) ultimo, count(*) filter (where status='running') rodando_agora
        from public.fin_sync_log group by action order by ultimo desc;"
```

## Famílias money-path (curado)

| Família | Cron(s) | Edge → action | `fin_sync_log`? | Cursor? | Probe de EFEITO (não `MAX(updated_at)` genérico) |
|---|---|---|---|---|---|
| **Financeiro CP/CR/mov** | `fin-sync-cp-2x` (0 8,14), `-cr-2x` (20 8,14), `-mov-2x` (40 8,14), `fin-sync-continuacao-10min` (*/10) | `omie-financeiro` → `sync_contas_pagar`/`_receber`/`_movimentacoes` | **sim** (`action='sync_contas_*'`) | **sim** (`fin_sync_cursor` CP/CR/mov por empresa) | último `complete` de cada action no `fin_sync_log`; cursor `next_page` deve zerar |
| **Vendas pedidos** | `vendas-sync-pedidos-oben-2h` (5 */2), `-colacor-2h` (20 */2) | `omie-vendas-sync` → `sync_pedidos` | **sim** | não | último `complete` de `sync_pedidos` no `fin_sync_log`. ⚠️ **NUNCA** use `sales_orders.created_at` (= data do pedido no Omie, pode ser futura) |
| **Vendas estoque/cadastro** | `omie-sync-estoque-*`, `sync-customers-vendas-daily` (0 5), `omie-sync-metadados-daily` | `omie-vendas-sync` → `sync_estoque`/`sync_customers`/`sync_products` | **sim** | (customers roda em background via waitUntil) | `fin_sync_log`; `product_costs.updated_at`; `omie_products`/`omie_clientes` `max(updated_at)` |
| **Reposição/compras** | `gerar-pedidos-diario-oben` (15 9), `-intraday-oben`, `disparar-pedidos-aprovados-oben` (0 13), `sayerlack-portal-watchdog` (*/5), `sayerlack-retry-orfaos` (*/15) | `gerar-pedidos-diario`, `disparar-pedidos-aprovados`, `enviar-pedido-portal-sayerlack` | **NÃO** (não logam em `fin_sync_log`) | não | `pedido_compra_sugerido` do dia; `status_envio_portal` preso; checks `reposicao_*` em `fin_alertas` |
| **Status SKU / espelho `ativo`** | `omie-sync-status-produtos-diario` (`30 3` — era `30 6`) | `omie-sync-status-produtos` (param `empresa`: OBEN/COLACOR/**ALL**) | **NÃO** (loga em `sync_reprocess_log`, `entity_type='sku_status_omie'`) | não | `max(ultima_sincronizacao)` em `sku_status_omie` por empresa + runs em `sync_reprocess_log`. ⚠️ **GOTCHA (2026-06-24):** o cron baseline manda `empresa=ALL`; a edge só aceitou ALL a partir de 24/06 — antes dava **400 antes do `running`** (quebrado em silêncio ~1 mês, nunca rodou via cron). Aqui **zero `running` ≠ não-bootou** → pode ser **param inválido** (a validação roda ANTES do insert do log). |
| **Scoring/carteira** | `daily-calculate-scores` (0 6), `scoring-recalc-batch-nightly`, `carteira-rebuild-nightly` | `calculate-scores`, `scoring/*` | não | não | `farmer_client_scores.calculated_at`; `customer_visit_scores` frescor |
| **Sentinela (vigias)** | `data-health-watchdog` (*/30), `fin-sync-watchdog` (*/30), `fin-sync-heartbeat` (0 11 1-5) | SQL local (sem `net.http_post`) | n/a | n/a | **ler** `fin_alertas` ativos; se o heartbeat sumiu, o próprio vigia morreu |
| **Notificações** | `afiacao_dispatch_notificacoes_30min` (*/30), `push-sla-tick` (*/15) | `dispatch-notifications`, `enviar-push` | não | não | `fornecedor_alerta` preso em `pendente_notificacao`; check `alert_channel` |

> ⚠️ Antes de aplicar a assinatura "zero `running` = não bootou", confirme que a edge **grava `running`** logo após o boot. As famílias com `fin_sync_log=sim` (financeiro, vendas) gravam. As com `NÃO` (reposição, scoring, notificações) **não** — pra essas, o sinal de morte é o **HTTP** (`net._http_response`) + a **tabela de efeito**, não a ausência de `running`.
>
> ⚠️ **E mesmo onde a edge grava `running`**, ela o faz **DEPOIS** de validar o input (auth, `empresa`). Um param inválido (ex.: `empresa=ALL` numa edge que não suporta) responde **4xx ANTES do `running`** → zero `running` pode ser **rejeição na borda**, não morte de runtime, e o cron mascara (o `net.http_post` enfileira "succeeded"; o 4xx só está em `net._http_response`, expurgado em ~6h). Quando a janela do cron já expirou, **capture ao vivo com um teste controlado**: reagende o cron para `*/2 * * * *` por poucos min (`cron.alter_job`), observe o `net._http_response` na hora, e **reverta**. Foi assim que o bug do `empresa=ALL` (omie-sync-status-produtos, quebrado ~1 mês) foi pego.

## Princípio (Lei #2 da skill)

O probe de efeito é por-sync e **validado ao vivo** (`psql-ro`) — se não souber a coluna certa, descubra com `information_schema.columns` antes (a lição do `company` vs `companies`). Frescor por "tempo desde o último `complete`" é **não-confiável** (loga em rajadas); o sinal de morte confiável é **`running` travado** (onde existe) + **HTTP de erro** + **efeito ausente cruzado com a janela esperada**.

## Manutenção

Registre aqui um sync novo só quando ele tiver **gotcha** (probe não-óbvio, não grava `running`, cadência estranha). O resto deriva da query ao vivo acima. Re-derive sempre que a `main` adicionar cron (as migrations `cron.schedule` em `supabase/migrations/`).
