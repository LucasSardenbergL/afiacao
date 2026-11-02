# Expurgo dos logs do tintométrico (plano v4, lote 12 — item B4)

**2026-11-01.** Migration `supabase/migrations/20261101221749_expurgo_logs_tintometrico.sql`, prova
`db/test-expurgo-logs-tint.sh` (PG17, 27 asserts, no núcleo do CI).

## O que entrou

- `private.expurgar_logs_tint(p_dias_runs=30, p_dias_erros=60, p_lote=2000, p_max_lotes=5)` + cron
  `expurgo-logs-tint` de hora em hora (`41 * * * *`, `statement_timeout 2min`, `lock_timeout 5s`).
  Cada chamada apaga no máximo 10k linhas por tabela, numa transação curta.
- 7 índices: `tint_sync_errors(created_at)` para o corte e `sync_run_id` nas 6 filhas de
  `tint_sync_runs` que não tinham (`tint_staging_formula_itens` com 497k linhas e mais 5 vazias).

## Por que cada janela

| Tabela | Janela | Leitor mais exigente |
|---|---|---|
| `tint_sync_runs` | 30 d | idempotência: a chave é um UUID por lote por ciclo (`connector/sayersync`), reenviada só no backoff do mesmo POST, então a linha só precisa existir durante o ciclo (minutos). Telas leem 24 h ou as últimas 200 |
| `tint_sync_errors` | 60 d | o card de rejeições lê 24 h; a janela maior é para investigar rejeição da fonte, e custa pouco (~54 linhas/semana) |
| `tint_importacoes` | **fora** | o DELETE exige índice em `tint_formulas.importacao_id`: 1M linhas, 993 MB, ~489k updates/semana pela promoção, que troca o `importacao_id` a cada upsert. Isso muda o custo da promoção, que o M-43 deixou intocada. A tabela tem 39 MB e cresce ~1,5 MB/semana |

## As armadilhas que o desenho evita

1. **`tint_sync_runs` não é log puro: é pai de 14 tabelas por FK.** São 12 `ON DELETE CASCADE`
   (staging) e 2 NO ACTION (`tint_staging_precos_base`, `tint_reconciliation_runs`). O
   `tint_staging_purge` guarda para sempre a linha mais recente por chave, que a promoção relê.
   Apagar run por idade cascatearia e apagaria essa linha sem erro nenhum. Por isso a função lê as FKs
   do catálogo a cada chamada e só apaga run **sem nenhuma filha**. Uma FK nova fica protegida sem mexer
   na função.
2. **FK sem índice transforma o expurgo em seq scan por linha.** O gatilho de RI de cada DELETE no pai
   busca a filha por `sync_run_id`. A função recusa a chamada inteira (55000) se alguma filha estiver
   sem índice, e a pós-condição da migration exige zero filhas sem índice.
3. **Fila da promoção não envelhece.** `promocao_status` `pendente` é a fila do `tint-promocao-tick`, e
   `erro` é o alarme do watchdog ("erro não resolvido não some pelo tempo"). Só saem `NULL`,
   `promovido` e `descartado`, e só com `status` `complete`/`error`.
4. Os erros saem antes dos runs na mesma chamada. Um run com erro ainda retido fica junto, então o
   contexto do erro não some antes do próprio erro.

Não pega o advisory lock do `tint-promocao-tick` (o `tint_staging_purge` pega): o expurgo não toca nada
que a promoção leia.

## Aplicação e números

<!-- preenchido após o apply -->
