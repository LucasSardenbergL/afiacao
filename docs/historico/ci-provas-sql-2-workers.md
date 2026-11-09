# Provas SQL: 2 workers por runner, 7 → 5 partes (fatia 2, 2026-11-09)

## Por quê

A fatia 0 ([ci-provas-sql-medicao-preparacao.md](ci-provas-sql-medicao-preparacao.md)) mediu que a
parte serial do `provas-sql` ocupa ~1 núcleo dos 4 do runner (p90 1,2; iowait ≈ 0), e que a
preparação de cluster é só ~20% do tempo. A alavanca maior era rodar 2 unidades ao mesmo tempo.

## O que mudou

- **`db/roda-nucleo-ci.sh` ganha `NUCLEO_WORKERS`** (padrão 1; o CI usa 2):
  - Cada unidade (prova × modo) roda num subshell, que entrega saída e veredito em arquivo. O pai
    lê os arquivos, e unidade sem veredito completo (subshell morto) **reprova**.
  - A porta vai por slot de worker, em faixas de 5000. Há provas que usam `PGPORT_TEST+i` por
    sabotagem e `+1` para cluster irmão.
  - A ordem de lançamento é um LPT aproximado: falsificações primeiro, depois por custo DESC.
  - `wait -n -p` exige bash ≥ 5.1. Abaixo disso, mais de 1 worker é erro, nunca série silenciosa.
- **Faixa serial.** Prova com `lock_timeout`/`statement_timeout` ≤ 2 s roda SOZINHA, antes do pool.
  O mesmo vale para a que cita uma dessas GUCs sem valor legível (critério conservador). Número puro
  conta como ms, que é a unidade dessas GUCs.
  - A lista é derivada do fonte a cada execução, então prova nova com timeout curto já nasce serial.
  - Em 2026-11-09 eram 21 provas, 23% do tempo do núcleo. As de 5 a 300 s ficam no pool.
  - A faixa foi pedida na revisão: um flake raro custa PR vermelho e re-run, o oposto da meta.
- **`ci.yml`:** de 7 para 5 partes, com `NUCLEO_WORKERS=2`. O ganho estimado era de 1,4–1,6× com a
  faixa serial. Isso basta para 5 partes (> 1,4×), não para 4 (> 1,75×).
- **`db/falsifica-nucleo-ci.sh`** ganha 5 casos (só com bash ≥ 5.1, que é o do CI):
  - controle verde com um par de provas que só passa se as duas rodarem AO MESMO TEMPO;
  - o mesmo par com 1 worker reprova, porque roda em série;
  - o par com `lock_timeout` de 200 ms num dos fontes reprova com 2 workers, porque a faixa serial
    o isolou;
  - subshell morto reprova;
  - assert vermelho num worker reprova.

  O piso externo do harness subiu de 67 para 72: um harness que pule os casos de 2 workers fica em
  67 e reprova.

## Medido (PR #3756, em DRAFT até os 2 runs)

Comparação com a main de mesmo `db/` (run 42545964493):

| | main (7 partes seriais) | run 1 (42546701412) | run 2 (42549127572) |
|---|---|---|---|
| unidades | 315 | 315, as mesmas | 315, as mesmas |
| contagens de asserts/sabotagens | — | idênticas | idênticas |
| harness | — | OK=72 XX=0 (piso 72) | OK=72 XX=0 |
| minutos de runner (Σ partes) | 112,8 | **69,6** | **70,0** |
| pior parte (min) | 19,2 | **15,0** | 18,3 |
| Σ das durações por unidade (min) | 107,9 | 103,0 | 102,8 |

- **A disputa entre os workers não infla a prova:** a soma das durações por unidade com 2 workers
  ficou no ruído da serial (103,0 e 102,8 contra 107,9). O ganho vem inteiro da ocupação dos núcleos
  ociosos.
- **A pior parte varia com o par que coincide.** No run 2, a parte 2 levou 18,3 min (15,1 no run 1).
  Lá, as duas unidades mais pesadas rodaram ao mesmo tempo: `test-rls-has-role-initplan-classe`
  passou de 195–199 s para 278 s, e `test-sayerlack-cancelado-com-compra-viva --falsificar` de
  187–205 s para 230 s. Mesmo assim ficou abaixo da main (19,2). Afinar o LPT para não juntar as
  maiores é ajuste fino; a soma de runner não muda.
- Nos últimos runs verdes da main, o `provas-sql` somava 96–120 min de runner, com pior parte de
  16–19. A meta do programa era ≤ 80 min de runner por run: **atingida** sozinha pela fatia 2.
- O PR também tira 2 jobs da fila de 20 da conta a cada run.

## Ressalvas e o que vem

- 2 runs verdes são evidência fraca para flake RARO. As candidatas óbvias (timeout ≤ 2 s) estão na
  faixa serial. Se aparecer flake numa prova do pool, ela entra na faixa por um `lock_timeout` curto
  explícito no fonte, ou o critério do `timeout_curto` cresce.
- **Fatia 1** (cópia de PGDATA vazio no lugar do `initdb`): a fatia 0 estimou ~8 min de runner em
  série. Com 2 workers isso vira ~4 min, então ela fica como ajuste fino a reavaliar.
- **Re-medir a tabela de custo** (`db/nucleo-ci-custo.txt`) com 2 workers não muda o LPT entre
  partes: a duração por unidade não inflou.

## Programa encerrado (2026-11-09)

Na main pós-merge, 2 runs (`workflow_dispatch`, mesmo commit) deram 73 e 79 min de runner, pior
parte de 18 min, e um push→`validate` de 19 min. Segunda opinião (Fable; o Codex não foi consultado,
cota a 90%) e a sessão concordaram em **encerrar**:

- **Runner ≤ 80:** batida, mas com folga fina (a variação histórica de ±12% põe um run ruim acima
  de 80).
- **Mediana push→`validate` ≤ 25:** ainda **não provada**. 1 run de dispatch, com a fila vazia, é
  ausência de dado.
- **Cobertura:** intacta (315 unidades e contagens idênticas).
- As fatias que sobraram não pagam o risco de mexer de novo no runner: separar as unidades pesadas
  daria ~3 min de espera e zero de runner, e a fatia 1 daria ~4 min de runner.

**Reabrir se**, nos PRs da semana seguinte, a mediana passar de 25 min, o p90 piorar em relação ao
de antes da fatia 2 (~31 de mediana), houver re-run por flake no `provas-sql` ou alguma parte
passar de 20 min. A consulta (duração do run inteiro, um pouco acima do tempo até o `validate`):

```bash
gh run list --workflow ci.yml --event pull_request --status success --limit 40 --json createdAt,updatedAt --jq '[.[]|((.updatedAt|fromdate)-(.createdAt|fromdate))/60|floor]|sort|"n=\(length) mediana=\(.[length/2|floor]) p90=\(.[length*0.9|floor])"'
```

**Primeira ação se reabrir** (ideia do Fable, ainda não conferida no código): pesar a faixa serial na
partição entre partes. Hoje o LPT soma o custo serial de cada prova, mas a prova da faixa serial
ocupa a parte inteira, enquanto a do pool divide o tempo com outra. Uma parte com muitas provas de
timeout curto fica mais lenta com a mesma soma. Pesar a prova serial ×2 muda só a função de peso,
não o laço do pool, e vem antes da separação das unidades pesadas e da fatia 1.
