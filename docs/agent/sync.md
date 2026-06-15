# Sync / cron / Sentinela — referência operacional

> Lições de design e armadilhas de cron/sync. Para **diagnosticar** um incidente, use a skill `diagnose-supabase-sync` (árvore de 8 passos + queries prontas pro `psql-ro`). Histórico de incidentes em `docs/historico/bugs-resolvidos.md` (bullets de sync) + os specs de incidente.

## A verdade está em `net._http_response`, não no `job_run_details`

`cron.job_run_details` reporta `succeeded` **mesmo quando a edge respondeu 401/503 ou nem bootou** — ele só registra que o `net.http_post` foi **enfileirado**. A verdade HTTP está em **`net._http_response`** (`status_code`/`content`/`error_msg`/`timed_out`), cruzada com `fin_sync_log` (iniciou/completou/órfã) e o **efeito no dado**. `status_code IS NULL` é mudo — sempre trazer `error_msg`/`timed_out` junto.

## Padrão de cron (canônico)

- Auth: header `x-cron-secret` = `(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)`. O secret já está no Vault.
- `cron.schedule(nome, schedule, comando)` faz **upsert por nome** → idempotente.
- **Todo cron `net.http_post` PRECISA de `timeout_milliseconds` explícito** — o default do `pg_net` é **5s** e mata SILENCIOSAMENTE qualquer função >5s (o `job_run_details` ainda diz "succeeded"). Teto padrão da casa: **150000** (150s).
- **Crons devem ser versionados em migration** — um cron que vive só no banco some sem rastro (já aconteceu: vendas ficou 8 dias morto porque o cron nunca foi versionado).

## Enumeração pesada do Omie (paginação)

- **Não confiar em `total_de_paginas`** — sub-reporta em lista grande. Paginar **até página vazia** + guard anti-loop; `registros_por_pagina>100` é **ignorado** pelo Omie.
- Enumeração pesada (~10k+) precisa de **bulk reads + background (`waitUntil`) + retry**, nunca N+1.
- ⚠️ Após corrigir a FONTE, **snapshots derivados não se regeneram sozinhos** — re-invocar o recompute (ver `docs/agent/reposicao.md`, cmc).

## Assinaturas de incidente (sintoma → causa → ação)

- **401 em muitas edges** → `CRON_SECRET` do Vault divergiu da env das edges → realinhar (Vault + edges no Lovable). ⚠️ `401` **isolado** (1 edge) pode ser `verify_jwt`/header/gate da própria edge, não secret.
- **`503 LOAD_FUNCTION_ERROR` + zero `running` no `fin_sync_log`** (1 edge) → a edge não BOOTA (pré-handler) → **redeploy verbatim** (não é código; o watchdog vê o efeito mas é cego pra causa de boot).
- **`546`/timeout 60s + zero `running` em VÁRIAS edges** → incidente de **plataforma** Supabase → esperar estabilizar, NÃO martelar redeploy.
- **`2xx` + órfã `running` antiga** → kill/`catch` não chamou `completeSync` (ou kill não passa pelo catch). É o sinal CONFIÁVEL de morte (≠ staleness por tempo).
- **`2xx` + `complete` + efeito ausente** → sucesso técnico falso / bug semântico → investigar a lógica (`prove-sql-money-path`).
- **cursor `fin_sync_cursor.next_page` parado >2h** → continuação travada.

## Princípios de diagnóstico

- **Vigie o EFEITO no dado, não o status técnico.** `complete` ocorre em **rajadas** (idle saudável parece "parado" — staleness por tempo-desde-complete é NÃO-confiável). `sales_orders.created_at` é a **data do pedido no Omie** (pode ser futura), NÃO frescor → usar `fin_sync_log` action `sync_pedidos`.
- **A tripla que desambigua em segundos:** edge irmã OK (200) + zero-401 + zero-`running` ⇒ a edge-alvo não boota.
- **Ausência ≠ falha.** Cron não-devido, fim de semana, resposta expurgada, par dormente — calcule a **última execução esperada** (com `now()` do BANCO, não relógio local) antes de gritar.
- ⚠️ A correlação `net._http_response × cron.job_run_details` por tempo é **cara** (a `job_run_details` é grande e sem índice em `start_time`) — preferir correlação por schedule + config + efeito. Considerar um índice em `job_run_details(start_time)` se virar rotina.

## Sentinela (vigia ativo)

- `data_health_watchdog` (cron `*/30`, SQL local) + `fin_sync_watchdog_check` (`*/30`) + `fin_sync_heartbeat` (dead-man-switch) computam saúde e fazem **push** na transição ok→degradado (grava `fin_alertas` + enfileira `fornecedor_alerta` → `dispatch-notifications`). Fonte única: `_data_health_compute()`.
- ⚠️ `_data_health_compute` é arquivo QUENTE multi-sessão. Ao recriá-lo, **parta da migration de MAIOR timestamp** (nunca de um corpo antigo) e **recrie `data_health_watchdog` + `fin_sync_heartbeat` JUNTO** (os IN-lists referenciam os `source` names; mudar o conjunto de checks sem atualizar os dois desincroniza o push). Pré-flight `pg_get_functiondef` é obrigatório — prod pode ter checks que o repo não tem (drift).

## Incidente em aberto (2026-06-14)

`omie-analytics-sync sync_inventory` das contas pesadas estoura 60s → `inventory_position` defasado (cmc velho). Mitigação aplicada (timeout 60→150s); medição do efeito pendente. Detalhe: `docs/superpowers/specs/2026-06-14-incidente-sync-inventory-timeout.md` + diário em `docs/historico/bugs-resolvidos.md`.
