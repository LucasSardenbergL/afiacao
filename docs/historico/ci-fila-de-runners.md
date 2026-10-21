# CI: o gargalo do `validate` no PR é a fila de runners, não a execução (2026-10-21)

**Sintoma.** O tempo até o `validate` no PR foi de 14–17 min (2026-10-20) para 44–55 min, e a execução
de cada job continuou curta.

**Linha de base** (15 runs de PR verdes, attempt 1, 2026-10-21 11:03–13:14 UTC; API do Actions):
p50 de **38,7 min** até o `validate` (15,5–55,4), com a fila até o 1º job em p50 1,3 min. Mas cada job
esperou p50 de **7 a 15 min** entre `created_at` e `started_at` (máx. 35), enquanto o maior job executa
em 15 min.

**Causa, medida.** É o limite de **20 jobs simultâneos** da conta, no plano Free com repositório
público. Linha do tempo de TODOS os jobs do repo em 19–21/10 (997 runs): a concorrência estaciona em 20
(514 min exatos nesse nível) e, dos jobs que esperaram mais de 60 s, 1.425 esperaram com 20 rodando e
293 com 19. A **demanda** de runner é o que enche a fila. Por evento: PR 15.930 min, pós-merge
(`workflow_dispatch`) 7.594 min, e dentro dele o `mutation-check` com 3 partes de ~19 min a CADA merge
(2.917 min, 13% do total).

**O que NÃO ajuda.** Juntar jobs curtos: o preâmbulo fixo é ~29 s por job (p50, 1.283 jobs do
`provas-sql`), então juntar economiza segundos e alonga o caminho crítico. Com a conta saturada, o que
pesa são os minutos de runner, não o número de jobs. Também não ajuda trocar 6 partes do `provas-sql`
por 4 equilibradas: dá ~14,3 min, o mesmo caminho crítico de hoje, e poupa ~1 min por run. O
`cancel-in-progress` de PR já existia (2026-10-02).

**O que mudou (#PR).**
1. O `mutation-check` sai do pós-merge (`auto-merge.yml` passa `mutcheck=false`). A rede de todos os
   contratos `.mut` fica no `schedule` diário, no push direto e no dispatch manual. O motivo antigo
   para excluir o `schedule` (o alarme vivia no `validate`) caiu com o `mutcheck-sensor`.
2. As partes do `provas-sql` passam a ser balanceadas pelo custo medido (LPT sobre
   `db/nucleo-ci-custo.txt`) em vez de round-robin. Pior parte: 14,2 → 9,6 min de núcleo. A união
   (`--uniao`) e a parte usam a mesma função (`atribui_partes`). O harness ganhou 2 casos (LPT com a
   prova cara por último; tabela malformada aborta), falsificados com controle verde na mesma
   invocação, e o piso subiu de 65 para 67.

**Depois.** Ver o corpo do PR. A tabela de antes/depois usa os mesmos 3 números em ≥5 runs.

**Lição.** Quando o tempo até o veredito cresce e a execução não, meça `started_at − created_at` por
job e a concorrência da conta antes de mexer no grafo de jobs. Reparticionar só move o gargalo de
lugar; reduzir a demanda é o que esvazia a fila.
