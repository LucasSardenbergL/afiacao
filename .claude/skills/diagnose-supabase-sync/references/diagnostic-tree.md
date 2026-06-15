# Árvore de diagnóstico — queries read-only por passo

Todas via `RO=~/.config/afiacao/psql-ro`. Schema validado em prod (colunas reais abaixo).
Substitua `<sync>` / `<action>` pelo alvo (ver `sync-registry.md`). **Use o `now()` do banco**, nunca o relógio local.

Colunas reais (não erre como `company` vs `companies`):
- `net._http_response(id, status_code, content_type, headers, content, timed_out, error_msg, created)` — **sem jobid**: correlação cron→resposta é por **tempo** (janela) + `content`.
- `public.fin_sync_log(id, action, companies[], status, results, error_message, triggered_by, started_at, completed_at, duracao_ms, api_calls, rate_limits_hit)`
- `public.fin_sync_cursor(company, resource, next_page, updated_at, backfill_desde)`
- `public.fin_alertas(id, company, tipo, severidade, mensagem, valor, threshold, contexto, criado_em, dismissed_at, dismissed_until, email_enfileirado_em)`

---

## Passo 1 — Escopo & expectativa

```bash
$RO -tAc "select now() as agora_no_banco;"
$RO -c "select jobid, jobname, schedule, active from cron.job where jobname ilike '%<sync>%';"
```
Calcule a **última janela em que deveria ter rodado** a partir do `schedule` + `now()`. Ausência só é falha se essa janela já passou (cuidado com fim de semana / `1-5` / cadência rara).

## Passo 2 — Confirmar o incidente

```bash
# alertas ATIVOS (não dismissados) — o que o Sentinela está gritando agora
$RO -c "select tipo, severidade, left(mensagem,70) msg, to_char(criado_em,'MM-DD HH24:MI') em
        from public.fin_alertas where dismissed_at is null order by criado_em desc limit 20;"
```
+ **probe de efeito do domínio** (ver `sync-registry.md` — NÃO `MAX(updated_at)` genérico). Ex.: vendas → última `sync_pedidos` em `fin_sync_log`; financeiro → idem CP/CR/mov.

## Passo 3 — Scheduler

```bash
# o command tem timeout_milliseconds? (sem ele, pg_net usa default 5s e mata função >5s, silencioso)
$RO -c "select jobname, active, schedule,
               (position('timeout_milliseconds' in command) > 0) as tem_timeout
        from cron.job where jobname ilike '%<sync>%';"
```
`job_run_details` só prova **enqueue** — não use como prova de sucesso. (Se quiser ver: `select status, return_message, start_time from cron.job_run_details where jobid=<id> order by start_time desc limit 5;` — mas trate como "foi enfileirado", não "rodou ok".)

## Passo 4 — Transporte HTTP (a verdade que o job_run_details esconde)

```bash
# janela estreita em torno do horário do cron — distribuição + corpo
$RO -c "select status_code, timed_out, to_char(created,'MM-DD HH24:MI') t,
               left(coalesce(content, error_msg, '(vazio)'),80) corpo
        from net._http_response
        where created > now() - interval '6 hours'
        order by created desc limit 30;"
# distribuição 24h (acha 401/503/546/NULL/timeout em massa):
$RO -c "select status_code, timed_out, count(*) n
        from net._http_response where created > now() - interval '24 hours'
        group by 1,2 order by n desc;"
```
⚠️ `status_code IS NULL` é mudo no leitor simples — **sempre** trazer `error_msg` e `timed_out` junto. `LOAD_FUNCTION_ERROR`/`WORKER_RESOURCE_LIMIT` aparecem no `content`.

## Passo 5 — Handler (cruza HTTP com a camada de aplicação)

```bash
$RO -c "select companies, action, status, left(coalesce(error_message,''),50) erro,
               to_char(started_at,'MM-DD HH24:MI') ini, to_char(completed_at,'MM-DD HH24:MI') fim
        from public.fin_sync_log where action ilike '%<action>%'
        order by started_at desc limit 10;"
# órfãs 'running' antigas (kill/catch não finalizou) — sinal CONFIÁVEL de morte:
$RO -c "select companies, action, to_char(started_at,'MM-DD HH24:MI') ini, age(now(), started_at) idade
        from public.fin_sync_log
        where status='running' and started_at < now() - interval '30 minutes'
        order by started_at limit 20;"
```
**Zero `running` no `fin_sync_log` + 503/timeout no HTTP = a edge nem bootou** (o `running` é inserido só DEPOIS do boot, no `try`). Mas confirme no registry que a edge grava `running` (nem toda grava).

## Passo 6 — Progresso (cursor)

```bash
$RO -c "select company, resource, next_page, age(now(), updated_at) idade
        from public.fin_sync_cursor where next_page is not null order by updated_at;"
```
`next_page` parado **>2h** = continuação quebrada (ou backfill saudável demorando — cruze com o HTTP/handler).

## Passo 7 — Contraprova (mata hipóteses)

```bash
# 401 sistêmico (muitas edges → secret) vs isolado (uma → gate/verify_jwt da própria edge)
$RO -c "select status_code, count(*) n from net._http_response
        where created > now() - interval '24 hours' group by 1 order by n desc;"
# 5xx/NULL/timeout recentes — uma edge (redeploy) ou VÁRIAS (plataforma → não martelar)?
$RO -c "select to_char(created,'MM-DD HH24:MI') t, status_code, timed_out,
               left(coalesce(content,error_msg,''),60) corpo
        from net._http_response
        where (status_code >= 500 or status_code is null or timed_out)
          and created > now() - interval '12 hours'
        order by created desc limit 25;"
```
A **tripla** que desambigua em segundos: sync irmão OK (200) + zero-401 + zero-running ⇒ a edge-alvo não boota. Repita em ≥2 janelas quando aplicável.

---

## Atalhos conclusivos (sintoma → causa → ação humana)

| Sinal (cruzado) | Causa provável | Ação (NÃO executo — entrego) |
|---|---|---|
| cron devido + enqueue + **401 em muitas edges** | `CRON_SECRET` Vault ≠ env das edges | realinhar secret (Vault + edges) no Lovable |
| **`503 LOAD_FUNCTION_ERROR` + zero `running`** (1 edge) | edge não BOOTA (pré-handler) | redeploy verbatim dessa edge (chat Lovable) |
| **`546`/timeout + zero `running` em VÁRIAS edges** | incidente de **plataforma** | esperar estabilizar; NÃO martelar redeploy |
| `2xx` + **órfã `running`** | catch/kill não finalizou | corrigir handler; watchdog reclassifica |
| `2xx` + `complete` + **efeito ausente** | bug semântico / sucesso falso | → `prove-sql-money-path` na lógica |
| cursor `next_page` **>2h** | continuação travada | forçar continuação / investigar budget |
| cron **sem `timeout_milliseconds`** | `pg_net` default 5s mata função | re-agendar cron com `timeout_milliseconds` |

⚠️ `401` **isolado** (1 edge) ≠ secret → pode ser `verify_jwt`/header/gate da edge.
