# E13 (V8-LOTE) descartado com medição — plano v6, lote 7

**2026-11-05.** O item E13 do plano v6 (`docs/superpowers/plans/2026-11-04-plano-melhoria-v6/README.md`, §2) propunha trocar o pool de 4 `node --check` do gate `edges:sintaxe` (`scripts/edges-sintaxe-gate.ts`, `checarJs`) por **1 processo Node persistente**. O plano já trazia uma condição: medir antes o step no runner e só implementar se o ganho na parede até o `validate` fosse relevante. A medição mostrou que não é. **Nada foi implementado.**

## Premissa

No ensaio local do Codex, os `node --check` levaram 28,9 s. O parse num processo só levou 146 ms. A transpilação (~16 s) é igual nos dois casos. A conta que o plano fez foi: "o gate gasta ~29 s à toa".

## Medição no runner

Os números são dos timings de job e step da API do GitHub (`gh api .../actions/runs/<id>/jobs`), em 8 runs `success` recentes do workflow `ci.yml`. São 5 de `pull_request` e 3 de `workflow_dispatch` na main. Os tempos `+Ns` contam desde o início do 1º job do run.

| run | step `edges:sintaxe` | fim do `edges-e-build` | último job antes do `validate` |
|---|---|---|---|
| 41998333538 (PR) | 7 s | +406 s | `testes` +432 s |
| 42004586590 (PR) | 5 s | +303 s | `testes` +485 s |
| 42005763626 (main) | 6 s | +374 s | `provas-sql-uniao` +1414 s |
| 42006052637 (PR) | 5 s | +333 s | `testes` +417 s |
| 42007120028 (main) | 6 s | +400 s | `provas-sql-uniao` +1444 s |
| 42008364111 (PR) | 8 s | +392 s | `provas-sql-uniao` +1185 s |
| 42010395426 (PR) | 5 s | +323 s | `falsificacao (2)` +425 s |
| 42011457569 (main) | 7 s | +413 s | `provas-sql-uniao` +1377 s |

## Veredito

- **O step inteiro dura 5–8 s no runner**, somando transpilação e `node --check`. O teto do ganho é esse, não os 28,9 s do ensaio local: aquele número saiu de um Mac M2 de 8 GB em swap, não do runner.
- **O `edges-e-build` não foi o caminho crítico em nenhum dos 8 runs.** Ele termina de 26 s a 182 s antes do último job nos runs sem provas SQL, e de 793 s a 1.044 s antes quando as `provas-sql` rodam. Zerar o step tira **0 s** da parede até o `validate`.
- O custo da troca não seria pequeno. Um worker persistente acrescenta um protocolo de IPC e uma falha-fechada nova (worker morto ou mudo tem de dar vermelho), e tudo isso precisaria ser falsificado. Ficaria código a mais num gate que existe por causa do #2720 (redeclaração que vira BOOT_ERROR no V8), sem ganho que o justifique.

### Depois do #3617 (vitest em 2 shards)

O lote 6 mergeou durante esta medição e derrubou o `testes` de 7,2 para ~4,4 min. Nos ~14% de runs **sem** provas SQL, o caminho crítico passou para o grupo `edges-e-build` / `falsificacao (n)` / `gates-e-falsificacao`, todos na faixa de 6,2–6,8 min ([histórico do lote 6](ci-lote6-v6-lpt-remedido-e-shard-vitest.md)). Re-medi 4 runs com shard:

| run | step `edges:sintaxe` | último job antes do `validate` |
|---|---|---|
| 42014823339 (PR, shard) | 7 s | `provas-sql-uniao` +1165 s |
| 42008364111 (PR, shard) | 8 s | `provas-sql-uniao` +1185 s |
| 42018005026 (PR, shard, sem provas) | 7 s | `falsificacao (3)` +593 s (o `edges-e-build` é o 4º, em +419 s) |
| 42016910290 (main) | 5 s | `provas-sql-uniao` +1236 s |

Mesmo no melhor caso, o de um run sem provas em que o `edges-e-build` fosse o último **e** o 2º colocado viesse a mais de 8 s dele, o ganho seria ≤ 8 s em ≤ 14% dos runs. Em média, isso dá menos de 1,2 s por run. O veredito continua o mesmo.

Mesmo raciocínio do D9 (#3609): a premissa era uma medição feita fora do lugar que importa. Medido onde vale, o item cai.

## Quando reabrir

Só se o `edges-e-build` passar a ser o último job antes do `validate` **e** o step `edges:sintaxe` passar de ~30 s no runner. Para conferir, refaça a query de timings acima: a pergunta sai da API, não de uma impressão.
