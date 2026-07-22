---
name: diagnose-supabase-sync
description: >-
  Diagnostica cron/sync/edge quebrado no Supabase deste repo (Afiação/Colacor) RODANDO as queries
  read-only DIRETO no Postgres de produção via o wrapper ~/.config/afiacao/psql-ro. Use SEMPRE que:
  o founder disser que "os dados estão velhos/desatualizados", "o sync parou", "não atualizou", "o
  número está defasado"; chegar email "[Sync parado]" / "[Saúde de dados]" / alerta do Sentinela; um
  cron parecer não ter rodado; ou um KPI/relatório estiver com dado antigo. Por quê: cron.job_run_details
  MENTE "succeeded" (só registra o enqueue do net.http_post) — a verdade está em net._http_response +
  fin_sync_log, e o diagnóstico é MULTI-CAMADA (scheduler → HTTP → handler → cursor → efeito no dado).
  100% READ-ONLY: eu diagnostico sozinho (sem você colar no SQL Editor) e ENTREGO a ação (redeploy de
  edge, rotacionar secret, forçar sync, dismiss) empacotada pra você aplicar — nunca aplico. NÃO use
  para: aplicar a correção (é escrita → SQL Editor / chat do Lovable); bug de LÓGICA numa função SQL
  (use prove-sql-money-path); erro de frontend/build; ou criar migration (use lovable-db-operator).
---

# Diagnose Supabase Sync

## Por que esta skill existe

Neste repo, sync de dados quebra **em silêncio** e o founder descobre dias depois (um incidente ficou 8 dias invisível). A causa é uma armadilha de observabilidade documentada no §5 do CLAUDE.md:

> **`cron.job_run_details` reporta `succeeded` mesmo quando a edge respondeu 401/503 ou nem bootou.** Ele só registra que o `net.http_post` foi **enfileirado**, não o resultado HTTP. A verdade está em **`net._http_response`** (`status_code`/`content`/`error_msg`/`timed_out`) cruzada com **`fin_sync_log`** (iniciou/completou/órfã) e o **efeito real no dado**.

Diagnosticar isso é multi-camada (scheduler → transporte HTTP → handler → cursor → efeito) e cheio de falsos sinais (`complete` em rajadas; `created_at` é data comercial, não frescor; ausência ≠ falha). Antes, cada passo exigia o founder colar SQL no SQL Editor e trazer o resultado — lento, e por isso o diagnóstico raramente acontecia a tempo.

**Agora há acesso read-only direto ao banco** (`~/.config/afiacao/psql-ro`, role `claude_ro`), então eu rodo a árvore inteira sozinho, em minutos, e entrego a você só a **conclusão + a ação**. (Se o acesso não existir nesta máquina, a skill cai no modo fallback: gera os blocos read-only pra você colar.)

## A Lei de Ferro (3 regras inegociáveis)

1. **100% read-only — nenhuma escrita, nem "inofensiva".** O wrapper `psql-ro` já força `SESSION READ ONLY` (barra escrita até via RPC `SECURITY DEFINER`). Mesmo assim, **nunca** rode com intenção de escrever. Lista do que parece leitura mas NÃO é: `SELECT net.http_post(...)` (efeito externo + pode **duplicar** uma operação money-path), `SELECT data_health_watchdog()/fin_sync_watchdog_check()` (escrevem `fin_alertas`), `SELECT ...dismiss...` (apaga evidência), qualquer RPC que force sync (mexe em cursor/rate-limit/money-path). A **ação corretiva é do humano** (passo final). Também: **nunca leia nem imprima o Vault** (`vault.decrypted_secrets`) — `BYPASSRLS` é acesso privilegiado; segredo não entra no diagnóstico.

2. **Vigie o EFEITO no dado, não o status técnico.** Um sinal sozinho mente. `job_run_details=succeeded` é só enqueue. `fin_sync_log.complete` ocorre em **rajadas** (idle saudável parece "parado"). `sales_orders.created_at` é a **data do pedido no Omie** (pode ser futura), não frescor. Prove o incidente por **efeito específico do domínio + correlação temporal**, nunca por `MAX(updated_at)` genérico nem por um único sinal.

3. **Diagnosticado ≠ corrigido.** Entregue o veredito nos **estados rígidos** abaixo. A ação (redeploy/secret/trigger/dismiss) sai **empacotada** pro humano, marcada `NÃO EXECUTADO`. Só declare **RECUPERADO** depois que o humano agir **e** um novo ciclo rodar saudável **com efeito no dado** — re-rodando a skill. "Redeploy solicitado" não é "corrigido".

## Como conectar (read-only)

```bash
RO=~/.config/afiacao/psql-ro      # wrapper blindado: SESSION READ ONLY + statement_timeout 30s
$RO -c "select now();"            # use o now() do BANCO, nunca o relógio local
```

Se `~/.config/afiacao/psql-ro` não existir (outra máquina), use o **modo fallback**: entregue cada query do `references/diagnostic-tree.md` como bloco read-only rotulado `🟣 Lovable → SQL Editor → cola → Run` e peça o resultado. O diagnóstico é o mesmo; só muda quem roda.

## O fluxo — 8 passos (detalhe + queries em `references/diagnostic-tree.md`)

Antes da árvore, ancore no **registry do sync** (`references/sync-registry.md`): qual cron → qual edge → qual `action`/empresa → cadência/timezone → semântica do `fin_sync_log` → **probe de efeito**. Sem isso o `net._http_response` é ambíguo (vários crons compartilham minuto/endpoint).

1. **Escopo & expectativa** — sync/empresa/action exatos; cron existe/ativo/`schedule`; **última janela em que DEVERIA ter rodado** (com `now()` do banco). Ausência só é falha se uma execução esperada já passou.
2. **Confirmar o incidente** — `fin_alertas` ativos vs `dismissed_at`; estado do Sentinela; **probe de efeito** do domínio (não `MAX(updated_at)` genérico).
3. **Scheduler** — cron ativo, `schedule` certo, e **tem `timeout_milliseconds`** no comando? (sem ele, `pg_net` usa default 5s e mata função >5s, silencioso). `job_run_details` só prova enqueue.
4. **Transporte HTTP** — `net._http_response` numa **janela estreita** em torno do cron: distribuição de `2xx/401/503/546/NULL`, `content`, `error_msg`, `timed_out`. Não "últimos erros" soltos.
5. **Handler** — cruza com `fin_sync_log`: iniciou (`running`)? completou (`complete`)? erro? **órfã `running`** antiga? (transforma HTTP em diagnóstico de **camada**).
6. **Progresso** — `fin_sync_cursor.next_page` pendente e **idade** (>2h = continuação quebrada); resultado parcial/duração.
7. **Contraprova** — edge **irmã** funciona? `401` **sistêmico** (muitas edges) ou **isolado** (uma)? outras edges também `503`/timeout? repetir em **≥2 janelas** quando aplicável.
8. **Veredito** — montar o pacote de saída abaixo.

## Atalhos conclusivos (sintoma → causa provável → ação humana)

| Sinal | Causa provável | Ação (do humano) |
|---|---|---|
| cron devido + enqueue presente + **401 em muitas edges** | `CRON_SECRET` do Vault divergiu da env das edges | realinhar o secret (Vault + edges) no Lovable |
| **`503 LOAD_FUNCTION_ERROR` + zero `running`** numa edge | edge não BOOTA (pré-handler) | **redeploy verbatim** dessa edge via chat do Lovable |
| **`546`/timeout 60s + zero `running` em VÁRIAS edges** | incidente de **plataforma** Supabase | **esperar estabilizar**; NÃO martelar redeploy |
| `2xx` + **órfã `running`** | kill/catch/finalização (não chamou `completeSync`) | corrigir o handler; o watchdog reclassifica órfã |
| `2xx` + `complete` + **efeito ausente** | sucesso técnico falso / bug semântico | investigar a lógica (→ `prove-sql-money-path`) |
| **cursor `next_page` parado >2h** | continuação travada | forçar continuação / investigar budget |
| cron **sem `timeout_milliseconds`** | `pg_net` default 5s mata função longa | re-agendar o cron com `timeout_milliseconds` |
| **invocação MANUAL (browser→edge): não-2xx no cliente aos ~150s + órfã `running` + crons da MESMA edge ok** | lote por invocação excede o request timeout (~150s) da edge; isolate morre SEM catch | reduzir o lote do chamador (ex.: `max_pages`) pela duração MEDIDA/pág; backfill grande → modo cursor (#1500) |

⚠️ **`401` isolado** (uma edge) pode ser `verify_jwt`/header/gate da própria edge — **não** conclua rotação de secret.

## Pacote de saída (a fronteira da autonomia)

Termine SEMPRE com este formato — é o que impede "diagnosticado" virar "corrigido":

```
DIAGNÓSTICO: CONFIRMADO | PROVÁVEL | INCONCLUSIVO  — <causa em 1 linha>
EVIDÊNCIAS: <sinais com timestamp + as queries que rodei>
AÇÃO HUMANA NECESSÁRIA: <comando/prompt EXATO — redeploy de qual edge / SQL de re-agendar / etc.>
NÃO EXECUTADO: <o que NÃO fiz por ser escrita: redeploy, secret, trigger, dismiss>
COMO REVALIDAR: <a query read-only que prova recuperação — efeito + novo ciclo>
ESTADO: AGUARDANDO AÇÃO HUMANA
```

Depois que o humano agir, **re-rode a skill**; só então `RECUPERADO` (com novo ciclo saudável + efeito no dado).

## Armadilhas (as que mais causam falso-diagnóstico)

1. **Atribuir `net._http_response` ao sync errado.** Vários crons compartilham endpoint/minuto e a resposta pode não identificar `action`/empresa. Sem correlação temporal + `fin_sync_log`, marque **INCONCLUSIVO** — não chute. E a recíproca: invocação **MANUAL** (browser→`functions.invoke`) **não passa pelo pg_net** — a ausência dela em `net._http_response` é esperada, não evidência; a verdade do clique está em `fin_sync_log` (`triggered_by`=UUID do staff) + `acoes_execucoes` (#1500).
2. **Staleness sem semântica.** `created_at` é data comercial; tabelas dormem legitimamente; `complete` é em rajadas. Use o **probe registrado por sync**, não `MAX(updated_at)`.
3. **Ausência tratada como falha.** Cron não-devido, fim de semana, resposta já expurgada do `net._http_response`, par dormente. **Calcule a última execução esperada** antes de gritar.
4. **Generalizar a assinatura "zero `running` = não bootou".** Só vale pra edges cujo contrato grava `running` logo após o boot. Confirme no registry por edge antes de concluir.

## Arquivos de apoio

- `references/diagnostic-tree.md` — os 8 passos com as queries read-only EXATAS (prontas pro `psql-ro`).
- `references/sync-registry.md` — catálogo dos syncs money-path (cron → edge → action → cadência → semântica do `fin_sync_log` → probe de efeito) + a query que re-deriva os crons do banco ao vivo.
- `evals/trigger-eval.json` — casos de disparo.
