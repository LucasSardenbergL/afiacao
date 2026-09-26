# Promoção assíncrona do tint-sync-agent (2026-09-25)

Migration `20260925210000_tint_promocao_assincrona.sql` + edge `tint-sync-agent` + UI (`TintSyncRuns`, `TintIntegracao`).
Referência viva: `docs/agent/tintometrico.md` (bullet "Promoção ASSÍNCRONA").

## O que estava acontecendo (psql-ro, 4 dias)

- Todo run de `formulas` que tocava **≥16 pares** `(cod_produto,id_base)` falhou (16/32/34/48/49); os de 1–2 pares passaram. O custo do promote escala por PAR (o `_formulas_latest` re-expande o latest de todas as cores do par).
- A edge chamava `tint_promote_sync_run` dentro do HTTP → `upstream request timeout` (~128s) → marcava o run `error` → 500.
- **O promote COMMITAVA mesmo assim** (7 de 7 runs grandes: `tint_importacoes='concluido'`, `inserts`≈511k). O dado entrava; o que falhava era a resposta. O conector não cacheava o hash → re-enviava todo dia → o banco re-promovia ~500k linhas.
- Enquanto isso o promote segurava o advisory lock, e o request seguinte morria em `lock timeout` (22 ocorrências em 10 dias, contra 11 `upstream request timeout` e **zero** 23514 — a CHECK da Fase 5 que o #2538 apontou como causa nunca apareceu).
- O `SET statement_timeout='300s'` do promote era inerte (SET na definição da função não re-arma o timer do statement corrente).

## Três premissas do handoff que a medição derrubou

1. "Os lotes grandes NUNCA entram" → entravam; o problema era o ACK. Mudou a leitura do custo (re-promoção diária), não o desenho.
2. "Não reusar `status` por causa do Guard 4 inv.(1), `_formulas_latest` só lê run `complete`" → o invariante estava **desatualizado desde julho**: o filtro por status foi a v2, descartada (59% dos headers legítimos vivem em runs `error`). O Codex achou isso lendo o repo; confirmei no `pg_get_functiondef` de prod. A decisão (colunas novas) ficou, pelo motivo certo (ingestão ≠ promoção).
3. "Status `error` no erro terminal = quarentena do staging" (minha proposta de desenho) → não existe quarentena, pelo mesmo motivo. Removido.

## Desenho entregue

Fila em `tint_sync_runs.promocao_*` e `tint_keys_snapshots.aplicacao_*`; cron `tint-promocao-tick` a cada 15s (1 item/tick, FIFO estrito por (account,store), try-lock, backoff 1→2 min, 3 tentativas → `erro`, `ok:false` → `erro` direto); cron `tint-promocao-watchdog` */10 (alertas `tint_promocao_erro` sem janela e `tint_promocao_atrasada` >45min). A edge responde 200 só com o enfileiramento confirmado.

## Revisão independente (Codex gpt-6-astra xhigh, design)

REPROVADO com 5 P1 + 1 P2 — incorporados: sem quarentena por status; cap de 50 limpezas/24h contado pela promoção (com fila, contar pela ingestão abria bypass); 200 só com UPDATE confirmado; alerta de erro sem janela de 7 dias; `proxima_em` NULL elegível + `clock_timestamp()` no backoff; retorno do RPC lido. **Contestado como escopo:** reativação, por re-expansão do par, de chave retirada pelo snapshot — comportamento herdado e deliberado (a 5b#1 o fixa em teste); a fila não o piora. Follow-up próprio.

## Prova

`db/test-tint-promocao-assincrona.sh`: X1 (premissa do timeout) + 43 asserts em 12 cenários + 11 falsificações, cada uma exigindo o conjunto EXATO de asserts vermelhos, na mesma invocação do controle verde, nos locales `C` e `pt_BR.UTF-8`. Edge: `promocao-fila_test.ts` (Deno).

## Lição que generaliza

**"O 500 prova que não gravou" é falso quando quem corta é o gateway.** A query segue, commita e segura locks — o sintoma aparece no request seguinte, com outra mensagem. Antes de concluir que uma escrita via RPC falhou, confira o efeito no banco. (Registrado em `docs/agent/database.md` §5.)
