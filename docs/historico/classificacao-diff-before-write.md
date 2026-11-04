# Classificação de fornecedores só escreve a linha que mudou (plano v5, lote 10 — D3, fatia 1)

> 2026-11-04. Migration `20261104113000_classificacao_diff_before_write.sql` · prova `db/test-fornecedores-classificacao.sh`
> (blocos D e R + 7 sabotagens novas).

## O problema

`public.classificar_clientes_fornecedores()` (chamada pela `aplicar_exclusao_fornecedores()`, cron 139
`classificar-fornecedores-nightly`, 07:15 UTC) fazia `UPDATE cliente_classificacao SET <3 flags>, updated_at = now()`
**sem WHERE**: toda linha, todo dia. Medido na prod (psql-ro, 2026-11-04 10:59Z, contadores desde o restart de
2026-10-31 10:33Z): 102.492 updates em 17.459 linhas, `max(updated_at) = min(updated_at) = 07:15:00` de hoje. ~70 mil
desses updates são dela (4 execuções × 17.459); o resto é o upsert de tags do `omie-analytics-sync`.

## Por que aqui o "pular linha igual" vale (e no B2 não valia)

No lote 14 do v4 ([hot-carimbo-sync-lote14.md](hot-carimbo-sync-lote14.md)) o carimbo de cada linha era **contrato**
(`_data_health_compute`, CMC de 48 h), e pular a escrita perderia a confirmação por linha. Aqui a varredura dos leitores
deu o contrário:

- ninguém lê `cliente_classificacao.updated_at`: nem `src/`, nem `supabase/functions/`, nem `db/`, nem view, nem nenhum
  `prosrc` de prod (`_data_health_compute` não referencia a tabela);
- todos os leitores só filtram `excluir_da_carteira = true` (carteira-rebuild, scoring/visit-score-recalc-client,
  `_shared/mapas-paginados`, `useFarmerScoring`, `fcs_block_flagged_insert`, `seed_targets_faltantes`,
  `private.margem_cliente_agregada`, a própria aplicar);
- o jsonb de retorno é descartado pelo cron.

A prova de que a classificação **rodou** já tem um escritor só: `cron.job_run_details` do job 139. Então `updated_at`
pode virar "última mudança da classificação da linha" (já era assim no `reverter_exclusao_fornecedor`), sem fabricar
nem perder frescor. Documentado em `COMMENT ON COLUMN`. O upsert de tags ficou fora: `tags_synced_at` **é** a
confirmação por linha do sync.

## O desenho

CTE `regua` calcula as 3 flags com as mesmas expressões de antes; CTE `escrita` faz `UPDATE … FROM regua` só onde a
tupla `(is_fornecedor, tem_venda_real, excluir_da_carteira)` é `IS DISTINCT FROM` a calculada. Retorno: `classificados`
segue sendo o total avaliado, `alterados` (novo) são as linhas escritas, `excluidos` igual.

**A armadilha que o CTE cria: a corrida com o upsert de tags.** A versão antiga recalculava o `SET` sobre a versão nova
da linha quando esperava um lock (EvalPlanQual relê `cc.tags_omie`). Com a régua numa CTE, o valor calculado vem do
snapshot do início do comando: se outra transação trocar as tags durante a execução, o WHERE é reavaliado contra a
versão nova, mas as flags gravadas seriam as das tags **velhas**, e isso chegaria a excluir da carteira quem deixou de
ser fornecedor. A guarda `cc.tags_omie IS NOT DISTINCT FROM r.tags_omie` pula a linha nessa corrida: o trigger já
re-derivou `is_fornecedor` e a próxima execução decide o resto.

## Prova (PG17, corpo vivo)

<!-- preencher com a execução -->

## Antes/depois na prod

<!-- preencher após o apply -->
