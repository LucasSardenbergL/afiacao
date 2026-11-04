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

Defasagem aceita (Codex): se a linha **não** era candidata no snapshot e o upsert troca as tags durante o comando, ela
nem chega a esperar lock, e a exclusão fica a de ontem até a próxima execução. A versão antiga não tinha essa janela
porque reescrevia tudo. Na prática o upsert roda às 05:00 e a classificação às 07:15. A corrida com o
`reverter_exclusao_fornecedor` (snapshot sem a exceção nova) existia igual na versão antiga.

A migration segue o molde TRAVA → PRE (md5 exato ∈ {predecessor de prod `c99d2afa…`, este `4f0e049f…`}) → CREATE OR
REPLACE → PÓS (md5, `SECURITY DEFINER`, `search_path`, volatilidade, ACL por `has_function_privilege`, e a função
**executada** numa subtransação desfeita por SQLSTATE própria, porque PL/pgSQL é late-bound). O Codex derrubou duas
versões da PÓS: o PRE aceitava corpo por substring, e a PÓS comparava `classificados` com um `count(*)` de **outro**
snapshot (em READ COMMITTED um upsert concorrente reprovaria um apply correto).

## Prova (PG17, corpo vivo — `db/test-fornecedores-classificacao.sh`)

A cadeia dinâmica do `db/lib/corpo-vivo.sh` pega a migration sozinha, e a PÓS dela roda na montagem. Normal:
**PASS=32 FAIL=0** (26 de antes + 6). `--falsificar`: controle verde (32) e **62 sabotagens vermelhas / 0 falhas**
(55 + 7).

| assert | o que mede |
|---|---|
| D0 | linhas novas (do trigger) são classificadas e **só elas** escritas |
| D1 | 2ª execução sem mudança: `alterados=0`, **0 updates físicos**, nenhum xmin nem carimbo mudou |
| D2 | UMA flag muda em cada uma de 3 linhas (venda, exceção, is_fornecedor): só as 3 escritas, régua certa |
| D3 | linha removida só sai da contagem |
| R0/R1 | corrida real com 2 sessões (FIFO): a execução **esperou** o lock e não gravou a régua das tags velhas |

O xmin diz QUAIS linhas foram escritas; o nº físico de updates vem de `pg_stat_xact_user_tables` na mesma transação
(Codex: reescrever 2× a mesma linha deixaria o xmin final igual). Sabotagens novas: `diff_ausente` (o defeito
original), `diff_cego_{isforn,venda,excluir}`, `guarda_ausente`, `alterados_mente`, `classificados_conta_escritas`.
Só `LC_ALL=C`: a prova fixa o locale, e nenhum assert depende de collation.

## Antes/depois na prod

Medido por psql-ro em 2026-11-04 12:03Z, sem escrever: a régua avalia 17.459 linhas e **0 mudariam agora**; o SELECT
da régua leva 1,2 s. Esperado depois do apply: o job 139 sai de 17.459 updates/dia para só as mudanças reais
(clientes novos do sync e flags que viraram). `n_tup_upd` antes do apply: 102.492 (12:03Z).

<!-- a medição do 1º ciclo do cron depois do apply entra aqui -->
