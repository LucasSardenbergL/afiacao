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

## Backfill histórico via invocação SERIALIZADA (motor cron temporário)

Pra disparar MUITAS invocações da MESMA edge/conta Omie (ex.: backfill mês-a-mês de `sync_pedidos`), monte um **motor cron temporário**: tabela de fila `(ordem, params, start_page, disparado_em, request_id)` + função tick que pega o próximo não-disparado e dispara **1** `net.http_post` + cron `*/6` que chama a função; `cron.unschedule`+`drop` no fim. Validado no backfill da Oben (2026-06-14, `docs/historico/programas-vendas.md`). Quatro armadilhas, cada uma custou uma rodada:

1. **Invocações CONCORRENTES na mesma conta Omie = rate-limit FATAL e SILENCIOSO.** O `callOmie` esgota os retries, retorna `null`, a edge trata como "página vazia = fim" e responde `{synced:0, totalPaginas:1, complete:false}` com **`status=complete` mentindo** — NÃO é "vazio", é rate-limit (o sinal é `synced=0` num período que você SABE ter dados). Serialize: **intervalo do cron > duração da invocação**. A `omie-vendas-sync` leva **~40s/página** (`getClientAddressPhone`/`ConsultarCliente` por cliente, cache por-invocação não persiste) → um mês ≈ 4-7 min → `*/6`+.
2. **A edge INSERE POR PÁGINA e roda em BACKGROUND além do timeout do `pg_net`** (150s) — páginas processadas antes do corte FORAM commitadas; o "timeout" não perde trabalho, e re-disparar (idempotente por `hash_payload`) continua. **Valide pela CONTAGEM no banco, não pela resposta** (que vem `NULL`/timeout). Mês de >10 páginas precisa de uma faixa extra com `start_page` alto (a edge morre no wall-clock antes das páginas finais com `start_page=1`).
3. **`pg_sleep` + `net.http_post` no MESMO Run do SQL Editor = ROLLBACK.** O Run é 1 transação, o `http_post` só enfileira no COMMIT, e o `pg_sleep` longo bate no `statement_timeout` do editor → rollback → os disparos somem (zero em `fin_sync_log`/`net._http_response`, fila vazia). O escalonamento é do CRON (intervalo), nunca do sleep.
4. **`filtrar_por_data_de/ate` do `ListarPedidos` filtra por data de PREVISÃO, não `dInc`** (com `filtrar_apenas_inclusao:"N"`) → pedidos de uma janela mensal espalham ±1 mês no eixo `order_date_kpi`. Cubra com leve overlap e valide a cobertura TOTAL, não mês-a-mês exato.

⚠️ **Recência pós-backfill:** `order_items.created_at` é `DEFAULT now()` e o `syncPedidos` NÃO o seta → itens backfillados nascem com `created_at=hoje`. O `calculate-scores`/`daily-calculate-scores` usa esse campo p/ recência → recomputar sem corrigir faz todo cliente do backfill parecer "comprou hoje". Após o backfill, **`UPDATE order_items.created_at = sales_orders.order_date_kpi`** nos itens backfillados, ANTES dos crons de scoring (`0 6`/`0 7`). A `customer_metrics_mv` usa `sales_orders.created_at` (= previsão, mais segura) — mas o `refresh_customer_metrics()` tem **gate de staff e falha no SQL Editor** (`auth.uid()` nulo) → `refresh materialized view concurrently public.customer_metrics_mv` DIRETO.

## Assinaturas de incidente (sintoma → causa → ação)

- **401 em muitas edges** → `CRON_SECRET` do Vault divergiu da env das edges → realinhar (Vault + edges no Lovable). ⚠️ `401` **isolado** (1 edge) pode ser `verify_jwt`/header/gate da própria edge, não secret.
- **`503 LOAD_FUNCTION_ERROR` + zero `running` no `fin_sync_log`** (1 edge) → a edge não BOOTA (pré-handler) → **redeploy verbatim** (não é código; o watchdog vê o efeito mas é cego pra causa de boot).
- **`546`/timeout 60s + zero `running` em VÁRIAS edges** → incidente de **plataforma** Supabase → esperar estabilizar, NÃO martelar redeploy.
- **`2xx` + órfã `running` antiga** → kill/`catch` não chamou `completeSync` (ou kill não passa pelo catch). É o sinal CONFIÁVEL de morte (≠ staleness por tempo).
- **`2xx` + `complete` + efeito ausente** → sucesso técnico falso / bug semântico → investigar a lógica (`prove-sql-money-path`).
- **cursor `fin_sync_cursor.next_page` parado >2h** → continuação travada.
- **`job_run_details.status='failed'` + `return_message='job startup timeout'` em MASSA (vários crons, horas seguidas)** → o pg_cron não conseguiu lançar o worker (background workers da plataforma esgotados), **não** é a edge/código. Transitório → confirmar pela **evolução horária** (o sucesso volta sozinho — ex.: 2026-06-15, timeouts 00h–11h UTC, recuperou às 12h) ANTES de reescalonar horários. `net.http_post` manual (pg_net, não usa worker de cron) **ainda funciona** no meio do incidente — usar pra forçar o recompute/sync que o cron perdeu.
- **`job_run_details.status='failed'` + `invalid input value for enum` num cron isolado, RECORRENTE** → a função usa um valor que **não existe no enum** (dessync repo×banco) e plpgsql é late-bound → aborta a cada tick, **silencioso por dias**. Ao mudar/renomear um enum, `grep` o código (SQL **e** frontend) pelos valores antigos. Caso: `tarefas_matcher_tick` usou `numero_errado` por 14 dias (enum era `numero_invalido`) → #877.

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
