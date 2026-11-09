# HOT update em contas a pagar, não em contas a receber (plano v5, lote 11 — D1)

> 2026-11-04. Migration `20261104120000_hot_contas_pagar_sem_indice_carimbo.sql` · prova
> `db/test-hot-contas-pagar.sh` · `getLastSyncTime` em paralelo. Molde: [lote 14 do v4](hot-carimbo-sync-lote14.md).

Mesma causa do lote 14: um btree **na coluna de carimbo** (`idx_fin_contas_{pagar,receber}_updated_at`, de
`20260615095710`) que o sync regrava em toda linha → nenhum update pode ser HOT → cada um insere uma entrada
nos 8 índices da tabela. O Codex (plano v5) pediu CP e CR **separados** e o CR reestimado depois do
incremental B3. Resultado: **CP muda, CR não**.

## Medido na prod (psql-ro, 2026-11-04 10:58Z, contadores desde o restart de 2026-10-31 10:33Z)

| | CP | CR |
|---|---:|---:|
| updates / HOT | 140.777 / 0 | 276.419 / 37 |
| linhas · páginas | 16.322 · 685 | 47.072 · 1.546 |
| writer (cron) | `fin-sync-cp-2x` 08:00/14:00 UTC, **FULL** | `fin-sync-cr-2x` 08:20/14:20 UTC, **incremental** |
| títulos por ciclo (`fin_sync_log`) | ~16,1 k, todo ciclo | 1.426 (04/11 08:20) + full de 45,6 k a cada 7 dias |
| updates/dia | **~32 k** | **~9 k projetados** (eram ~91 k antes do B3) |
| max(updated_at) sem índice, quente / frio | 6,5 ms / 611 ms (520 págs. do disco) | 17 ms / 1.160 ms (1.065 págs.) |

O banco tem 6,8 GB e `shared_buffers` de 256 MB: essas tabelas saem do cache entre syncs (o 1º seq scan da
medição leu 2/3 do heap do disco). Isto o lote 14 não tinha (lá estava tudo em cache).

**Leitores do carimbo** (pg_proc da prod + `src/` + edges): `_data_health_compute` (max, contrato de 26 h) e
`getLastSyncTime` (top-1 via PostgREST, sob RLS). `fin_cr_excluir_confirmados` filtra `updated_at` depois do
JOIN por chave, e o `updated_at` do `DISTINCT ON` das views `v_titulo_encargos_*` é o de `fin_movimentacoes`
(correção do Codex) — nenhum dos dois usa o índice.

**O custo escondido é a RLS.** A policy de SELECT é `fin_user_can_access(company)`, plpgsql com 2 lookups,
avaliada **por linha** num seq scan. Em PG17, no formato da prod, o top-1 sob RLS (staff) sem o índice leu
49.890 buffers em ~0,2–0,3 s no CP e 139.443 buffers em ~0,4 s no CR (com índice: 167). Mas
`fin_movimentacoes` (147.463 linhas, 5.057 páginas) **já não tinha** índice no carimbo, e o `getLastSyncTime`
lia CR → CP → movimentações **em série** antes do `useFinanceiro` mostrar o resumo. O PR põe as 3 leituras em
paralelo (`Promise.all`): a latência passa a ser a da mais lenta (movimentações), e o CP sem índice fica atrás
dela. Teste falsificável em `getResumoFinanceiro.test.ts`: as 3 chamadas a `.from()` saem antes de qualquer
`await` voltar.

## Decisão

- **CP — SIM: drop do índice + `fillfactor = 80`.** São ~32 k updates/dia, 100% não-HOT, ~258 k entradas de
  índice/dia. Na prova (abaixo), o HOT vai de 0% para ≥ 99,7% e o WAL do ciclo cai 65% (com FPI) a 83% (sem). O custo é o
  `max()` do data_health (+6,5 ms quente) e o top-1 do `getLastSyncTime`, que agora corre em paralelo.
- **CR — NÃO agora.** Com o incremental o volume caiu ~10× (de ~91 k para ~9 k/dia). No PG17 o CR também
  chegaria a ~100% de HOT (incremental: 0% → 100%, WAL do ciclo 1,2 → 0,22 MB), mas o ganho é ~1/3,5 do CP e
  o leitor custaria 2,3× (1.546 páginas, 1,16 s numa amostra fria no data_health; +47 k avaliações de RLS).
  **Reabrir se** o CR voltar a ≥ ~30 k updates/dia — sinal de que o incremental está caindo em full
  (`estado_ilegivel`/`sem_full`/continuação). É gatilho de investigação, não um ponto de equilíbrio provado
  (Codex). Os ~9 k/dia são projeção de um incremental de 1 dia; vale reconferir com uma semana de
  `fin_sync_log`.

## Por que fillfactor de novo (a prova)

`db/test-hot-contas-pagar.sh`, PG17. O formato é o da prod (colunas, `saldo` gerado, 8 índices, linhas por
empresa, ~170 B/linha). O upsert é o da edge (todas as colunas do payload, página Omie de 100, 1 statement
autocommit, ordem de chave). Cada ciclo tem CHECKPOINT antes (WAL com FPI) e VACUUM depois, e 20 títulos
abertos viram de status (coluna indexada, update não-HOT legítimo, dentro do denominador).

| variante (8 ciclos pós, mesmo estado aquecido) | pior HOT dos ciclos 6–8 | WAL do ciclo, com FPI | sem FPI |
|---|---:|---:|---:|
| controle (índice, ff100) | 0% | 20,2 MB | 15,1 MB |
| drop sem fillfactor | 89,3% | — | 2,9–4,0 MB |
| **drop + fillfactor 80 (a migration)** | **99,7%** | **7,05 MB (−65%)** | **2,6 MB (−83%)** |

"Com FPI" = CHECKPOINT antes de cada ciclo (o que a prova versionada faz): as imagens de página inteira do
heap (848 páginas ≈ 6,9 MB) continuam, e as dos 8 índices somem. A coluna "sem FPI" veio da 1ª versão da
prova, que não fazia checkpoint por ciclo, e mostra o teto do ganho. O assert foi re-calibrado de < 30% para
< 50% do controle quando o CHECKPOINT entrou. Foi a 1ª rodada vermelha (35%), e é o ponto P2 do Codex
confirmado.

Também prova: denominador exato em todo ciclo; heap parado (848 → 848 páginas, máximo dos 8 ciclos); valores
de negócio intactos (md5); carimbo do último ciclo em toda linha; página não confirmada mantém o carimbo
antigo; `max()` = último ciclo; CR intocado; idempotência; NOWAIT aborta com 55P03 sem mudar nada.
Falsificações, com controle verde na mesma invocação: 6 guardas (sem DROP, ff90, índice parcial, INCLUDE,
expressão, nome do índice apontando para outra tabela). Cada uma aborta com a marca do ramo **e** deixa o
índice e o fillfactor como estavam. São 2 causais: sem DROP o HOT fica em 0%; sem fillfactor, em 89,3%.

O WAL de laboratório **não** é previsão da prod (Codex: FPI, checkpoints, autovacuum de verdade). O número
que vale é o medido depois do apply.

## Aplicação

DDL destrutivo (`DROP INDEX`) → **founder**, no SQL Editor do Lovable (o arquivo inteiro numa colagem: a
transação implícita é o envelope), ou pelo `bun run db:aplicar` se o founder pedir explicitamente (precedente:
lote 14). Pré-voo psql-ro 🟢 (2026-11-04): o índice é de `fin_contas_pagar`, é o único que depende de
`updated_at`, e `reloptions` está vazio.

**Janela:** fora de 08:00–08:50 e 14:00–14:50 UTC (CP 08:00/14:00, CR :20, mov :40) e fora de :00/:30
(watchdogs). Menor carga: 23:00–07:45 UTC (20:00–04:45 BRT), num :15 ou :45. Se a tabela estiver ocupada, o
NOWAIT aborta e é só re-rodar.

**Convergência esperada:** ~5 ciclos = ~2,5 dias a 2 ciclos/dia. Na prova, o 1º ciclo pós já passa de 50% e
os ciclos seguintes sobem até ≥ 99%. Na prod do lote 14, o 1º ciclo deu 77–97%.

## Observação do Codex fora do escopo

O ramo `ABERTO → VENCIDO` da edge compara a meia-noite UTC do vencimento com `new Date()`. Esse ramo é
**inalcançável hoje**: a Omie devolve `A VENCER`/`VENCE HOJE`/`ATRASADO`/`PAGO`/`CANCELADO` (psql-ro: zero
títulos de CP com `ABERTO` ou `VENCIDO`). Sem ação.

## Antes/depois na prod

Aplicada em 2026-11-04 às 15:45:04Z por `bun run db:aplicar`. O ensaio antes respondeu `POS ok` e fez
rollback. Ledger `db_aplicacoes`: recibo #892 `aplicada`, sha256 `b23303c7424b…`, commit `3f1c8872a`.
2ª testemunha (psql-ro): `idx_fin_contas_pagar_updated_at` ausente, CP com 7 índices e `{fillfactor=80}`,
CR intacto (índice presente, `reloptions` nulo).

Medido por psql-ro em volta do 1º ciclo de CP depois do apply (cron 76, 2026-11-05 08:00Z):

| | antes do ciclo (07:55Z) | depois do ciclo (08:55Z) | Δ |
|---|---:|---:|---:|
| `n_tup_upd` | 156.935 | 173.093 | 16.158 |
| `n_tup_hot_upd` | 0 | 15.908 | 15.908 |
| **HOT do ciclo** | — | — | **98,5%** |
| páginas do heap | 685 | 685 | 0 |
| `n_dead_tup` | 467 | 664 | autovacuum às 08:02Z |

- **Primeiro ciclo já em 98,5%.** A prova PG17 assertava só os ciclos 6–8 (≥ 98%) e esperava
  convergência em uns 5 ciclos. Na prod o 1º ciclo já chegou lá. Explicação provável, não medida: o heap de
  685 páginas para 16,3 k linhas já tinha folga, deixada pelos updates não-HOT de antes.
- **Frescor intacto.** O carimbo das 3 empresas foi renovado no ciclo (colacor 11.867, colacor_sc 941,
  oben 3.350 linhas tocadas; último às 08:10Z). O `data_health_watchdog` de 08:30Z avaliou 25 checks com
  0 falhos, e não havia alerta de `data_health`/`sync` aberto em `fin_alertas`. Também ficou verde nas
  rodadas de 16:00Z, 21:30Z e 07:30Z entre o apply e o ciclo.
- `deriva:corpo:prod` em exit 0 depois do apply.
- **Publish do `getLastSyncTime` em paralelo: pendente** em 2026-11-05 09:00Z. O bundle no ar seguia
  `index-Bo5Gh-CB.js`. O modo automático barrou o `deploy_project` da sessão; o Publish ficou com o founder.
- **Publish conferido em 2026-11-05 14:41Z** (`verify-frontend.sh`, pelos bytes): o entry servido passou a `index-RqRdHGLt.js` e contém sentinelas exclusivas de commits **posteriores** a este (`44c171da4`, C5 do v6, e `3661972a1`, F9), dos quais este é ancestral (`git merge-base --is-ancestor`). O `getLastSyncTime` paralelo está, portanto, no build servido. Bytes provam disponibilidade, não adoção: o SW só troca quando o cliente aceita a atualização.
