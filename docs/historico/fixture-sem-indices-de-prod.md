# O custo era o plano, não o universo — a fase5-watchdog e o fixture sem os índices de prod

**2026-09-27.** `db/test-tint-fase5-watchdog.sh` (a prova de `tint_watchdog_fase5_check`, migration
`20260730120000`) ficou fora do núcleo no #2605 por custar **185s e 252s** no runner, mais que o
núcleo inteiro de antes. O motivo declarado no manifesto era *"universo de ~464 mil chaves × 17
execuções do watchdog × (controle + 4 sabotagens)"*, e a entrada dependia de **encolher o
universo**. Medido no runner, as três parcelas estavam erradas.

## O "universo de 464 mil" era um número da asserção

`463995` é a baseline de PROD (psql-ro, 2026-07-28) que a migration grava como **literal** em
`sync_state.metadata.universo_max`, e é ela que a B15b confere. O seed da prova monta **4 + 1.000
chaves**, e 1.000 já é o piso: o B5 afirma `v_s1 >= 1000 -> critico`, limiar **absoluto** na
migration. Encolher o universo exigiria semear um lote só para o B5 e removê-lo depois — muita
complexidade para atacar um custo que não estava ali. O universo, o seed e as 31 asserções ficaram
como estavam.

## Onde estava o tempo (runner, prova original instrumentada, VM1 / VM2)

| parcela | VM1 | VM2 |
|---|---|---|
| total | 213s | 251s |
| seed (1.004 chaves) | 0,03s | 0,03s |
| 120 varreduras do watchdog (6 suítes × 20) | 171s | 210s |
| … das quais as **2 primeiras** | **121s** | **145s** |
| B14 (`sleep 2` + espera do `pg_sleep(6)`) | 36,1s | 36,1s |

Não eram "17 execuções × universo": o custo se concentrava nas duas primeiras varreduras. A view
`v_tint_formula_canonica` é correlacionada por fórmula (`EXISTS` nos itens, `max()` pela chave,
`NOT EXISTS` com LATERAL por gêmea), e o fixture não tinha estatística nem os índices de prod. O
planner resolvia tudo em laço aninhado até o autovacuum analisar as tabelas, por volta de 60s. A
variação 185s × 252s era o sorteio de QUANDO isso acontecia.

## Uma varredura, isolada (ms, mediana; VM1 / VM2)

| chaves no seed | sem índice, sem estatística | sem índice, com `ANALYZE` | **com os índices de prod** |
|---|---|---|---|
| 100 | 111 / 130 | 2 / 2 | 1,6–3 |
| 250 | 1.207 / 1.443 | 3 / 3 | 2–9 |
| 500 | 8.937 / 10.984 | 4 / 6 | 4–38 |
| 1.000 | **64.480 / 80.004** | 8 / 11 | **7–25** |
| 2.000 | 258 / 326 | 145 / 196 | 12–39 |

Os índices que faltavam são os de prod, com os nomes de lá: `UNIQUE (formula_id, corante_id)` em
`tint_formula_itens` e `idx_tint_formulas_busca_cor (account, sku_id, cor_id)`. Com eles, nenhuma das
combinações de tamanho e estatística passou de 40ms (a coluna junta sem e com estatística). Sem eles, o plano muda de forma não-monotônica:
2.000 chaves com estatística custaram ~18× mais que 1.000.

## O ANALYZE entrou e saiu — a ablação decidiu

A 1ª hipótese foi `ANALYZE` após o seed. Sozinho, ele eliminou as duas primeiras varreduras lentas,
mas a prova ainda levou 113s e 122s: o autovacuum re-analisava no meio e o plano oscilava entre
0,02s, 0,2s e 3s por varredura. Com os índices, a ablação de cada camada, 2 VMs:

| variante (com o B14 novo) | tempo total |
|---|---|
| índices + `ANALYZE` | 23–34s — o plano troca para ~0,22s/varredura na **3ª suíte, nas duas VMs** |
| índices, **sem** `ANALYZE` | 11,4–12,0s — ~0,03s/varredura nas 7 suítes |
| `ANALYZE`, sem índices | 97–102s |

Com os índices, a estatística **piorou** o plano (a estimativa deriva conforme as suítes deixam tuplas
mortas). O `ANALYZE` saiu. E o cluster da prova passou a subir com `autovacuum=off`, porque a prova de
~12s termina antes do 1º ciclo do autovacuum. Num runner lento, ele produziria justamente a
estatística que a ablação mediu como o regime lento.

## O B14 parava o relógio 6s por suíte

`pg_sleep(6)` numa sessão em background, mais `sleep 2` antes do `roda` e um `wait` pela sessão:
~6s por suíte, 6 suítes. E era um palpite: uma sessão que levasse mais de 2s para pegar o lock
deixava o B14 medir o watchdog SEM contenção.

Agora a sessão segura o lock até ser encerrada (`pg_terminate_backend` pelo `application_name`,
então morre mesmo se ainda não o tiver pegado), e as duas esperas são POSITIVAS e com teto: o
`pg_locks` tem de mostrar a chave do watchdog com OUTRA sessão antes do `roda`, e livre depois.
Estourar o teto é falha, não "segue esperando". Custo: ~0,15s por suíte.

Como o mecanismo mudou, entrou a sabotagem **F5** (tira a anti-sobreposição da função e exige
`{B14}` vermelho). Sem ela, nada provaria que o B14 novo ainda morde. As camadas novas foram
sabotadas uma por vez, no runner, com o controle verde na mesma invocação: sessão do lock com outra
chave → a pré-condição reprova; encerramento que não acha a sessão → a pós-condição reprova;
sabotagem com âncora que não casa → `FAIL=1` no recibo.

## Resultado

MEDIDAS_RESULTADO_AQUI

F1–F4 derrubam exatamente os mesmos conjuntos de antes, e F5 derruba `{B14}`. O cabeçalho da prova
declarava `{B2,B13a,B13b}` para o F4, mas o conjunto medido, e já declarado no código, é
`{B2,B10,B12,B13a,B13b}`: corrigido. O recibo `PASS=31  FAIL=<asserts + sabotagens inválidas>`
substitui o `31 ok / 0 falhas`, que o `db/roda-nucleo-ci.sh` não casa ("falhas" ≠ "fail").

## Lições

1. **Número copiado de uma asserção não mede o fixture.** O 463.995 estava no arquivo e virou "o
   universo" por leitura. O inventário do fixture é o seed, e é o seed que se mede.
2. **Fixture de prova SQL espelha os índices de prod.** Sem eles, uma view correlacionada vira laço
   aninhado, o custo fica super-linear em N e o tempo passa a depender de quando o autovacuum
   acorda. Na prod, o plano nunca roda sem índice.
3. **`ANALYZE` não é conserto de graça.** Aqui ele resolveu o sintoma de uma camada e piorou a
   seguinte. Só a ablação (tirar uma camada por vez, no runner) mostrou isso. A camada que fica
   verde sem ser removida é redundante; esta ficava mais rápida sem ela.
4. **`sleep N` em prova é palpite duas vezes**: custa N sempre, e erra quando o ambiente demora
   mais que N. Espera em prova é positiva e com teto
   ([espera-sem-desistencia.md](espera-sem-desistencia.md)).
