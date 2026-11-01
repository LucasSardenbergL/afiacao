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

**O que mudou (#3313).**
1. O `mutation-check` sai do pós-merge (`auto-merge.yml` passa `mutcheck=false`). A rede de todos os
   contratos `.mut` fica no `schedule` diário, no push direto e no dispatch manual. O motivo antigo
   para excluir o `schedule` (o alarme vivia no `validate`) caiu com o `mutcheck-sensor`.
2. As partes do `provas-sql` passam a ser balanceadas pelo custo medido (LPT sobre
   `db/nucleo-ci-custo.txt`) em vez de round-robin. Pior parte: 14,2 → 9,6 min de núcleo. A união
   (`--uniao`) e a parte usam a mesma função (`atribui_partes`). O harness ganhou 2 casos (LPT com a
   prova cara por último; tabela malformada aborta), falsificados com controle verde na mesma
   invocação, e o piso subiu de 65 para 67.

**Depois** (5 runs de PR verdes, 16:12–17:02 UTC, após o merge do #3313 às 16:04:57Z): p50 até o
`validate` **38,7 → 19,5 min** (13,6–29,1). Fila até o 1º job: 1,3 → 0,1 min. Espera por job: p50
6,8–15,1 → 0,1–5,8 min. **Ressalva:** a carga caiu à metade (~9,5 → ~4,3 runs de PR/h), então parte do
ganho é a tarde calma. Os efeitos da mudança que independem da carga: o pós-merge da main foi de
**148 → 102 min de runner por run** (o mutcheck sai `skipped`), e o caminho crítico sem fila foi de
15,5 → 13,6 min.

**Tropeço:** uma prova nova (`test-radar-cadastro-omie-idempotente`, 148 s) entrou na main depois da
medição e pesou o default (30 s). A parte 1 foi a 13,1 min em vez de ~10. Ela entrou na tabela no PR
seguinte. Prova cara nova desequilibra até a tabela ser re-medida: confira com
`comm -23 <(grep -oE '^db/test-[^ ]+' db/nucleo-ci.txt | sort -u) <(grep -oE '^db/test-[^ ]+' db/nucleo-ci-custo.txt | sort -u)`.

**Carga moderada** (2026-10-27 14:00–17:00 UTC: 14 runs de PR, 4,7/h; 11 verdes no attempt 1): p50 até o
`validate` de **16,8 min** (12,4–23,0). Fila até o 1º job: 0,1 min. Espera por job: p50 0,1–2,8 min
(máx. 11,2). A conta ficou com ≥19 jobs simultâneos durante 70 dos 180 min. As 6 partes do `provas-sql`
executaram em 10,1–11,5 min (p50), já com a tabela de custo completa. Sem fila, o caminho crítico foi de
12,4 min.

**Rajada e tabela velha** (2026-10-28 00:00–03:00 UTC: 17 runs de PR, 5,7/h; 14 verdes no attempt 1):
p50 até o `validate` de **22,1 min** (16,3–38,0). A hora 01:00 teve 8 runs de PR, e os 7 verdes entre 01:03
e 01:42 deram p50 de 28,8 min. Fila até o 1º job: 0,7 min. Mas parte da piora não era fila: a
`provas-sql (6)` executou em p50 16,3 min contra 10–12 das outras. Seis provas tinham entrado sem
custo medido, e uma delas (`test-radar-cadastro-conflitos`, ~6 min) pesava o default de 30 s. A
`test-fin-consolidado-ic` também tinha crescido de 32 para 218 s. A tabela foi re-medida inteira
(mediana de 4 runs de 28/10). Com ela, `--lista` dá 12,0 min de custo em cada uma das 6 partes,
contra uma pior parte de 15,3 min com a tabela velha. Lição repetida: prova cara nova sem custo vira
o caminho crítico em dias. A receita do `comm` acima pega isso antes. Depois da re-medição (#3389,
merge 10:59Z): as 6 partes executaram em p50 11,7–13,7 min (antes 10–16), e o p50 até o `validate`
foi de **14,5 min** (14,0–15,1) com fila ~0. São só 3 runs verdes, todos às 11h UTC, com pouca carga.

**Tabela velha de novo, e o teto** (2026-11-01, lote 1 do plano v4). Em 15 runs verdes de PR, a
`provas-sql (2)` levou p50 18,9 / máx 19,9 min de job contra o teto de 20. Dois runs em 15 foram
cancelados no teto e re-rodados (+25 min cada). A tabela de 10-28 previa 846–852 s por parte, e o real
foi de 930 a 1.160 s. Dezessete provas tinham entrado sem custo e pesavam o default de 30 s. A pior
era `test-radar-contato-integridade`, com ~204 s. Outras ficaram mais caras, como `test-venda-repasse`
(112 → 215 s). A tabela foi re-medida inteira pela mediana dos 15 runs. Refeita a partição com as
durações de cada run, a pior parte passa de p50 18,3 / máx 19,3 para **15,4 / 16,0 min** de núcleo.
Fora da amostra (custo dos 10 runs mais velhos, aplicado aos 5 mais novos), ela fica em 15,2–16,3 min.
O teto subiu de 20 para 25 junto, como guarda e não como conserto. Os números de cada run e as partes
do run do próprio PR estão no corpo do PR. A lição de 10-28 se repete: o `comm` acima é o que avisa.

**Pico (ainda em aberto).** A comparação justa com a linha de base pede ~9,5 runs de PR/h. Desde o
#3313 nenhuma hora passou de 5. A tarefa agendada de 2026-10-22 falhou pelo limite semanal de uso, e a de
2026-10-27 parou no portão de ≥8 runs/h. Quando houver um dia com muitas sessões em paralelo: liste os
runs `CI` de `pull_request` verdes e com `run_attempt=1` (`gh api repos/LucasSardenbergL/afiacao/actions/runs`),
baixe `runs/<id>/jobs?filter=all` de cada um e conte `validate.completed_at − run.created_at` e, por
job, `started_at − created_at`.

**Lição.** Quando o tempo até o veredito cresce e a execução não, meça `started_at − created_at` por
job e a concorrência da conta antes de mexer no grafo de jobs. Reparticionar só move o gargalo de
lugar; reduzir a demanda é o que esvazia a fila.
