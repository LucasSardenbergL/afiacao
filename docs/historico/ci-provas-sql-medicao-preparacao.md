# Provas SQL: preparação × teste e CPU livre, medidos no CI (fatia 0, 2026-11-08)

## Por quê

O merge espera o `validate`, e o gargalo é o `provas-sql`: 7 partes, 100–113 min de runner por run,
73% do run. A fase 1 já mergeou: fsync=off ([ci-provas-sql-durabilidade-off.md](ci-provas-sql-durabilidade-off.md))
e esperas por condição (#3725, #3734, #3743). As duas próximas alavancas eram:

- **fatia 1**: reaproveitar um cluster recém-criado (ou um snapshot pré-carregado) no lugar do
  `initdb` + carga a cada execução;
- **fatia 2**: 2 provas simultâneas por runner.

Elas se sobrepõem e não somam. Esta fatia mede qual vem primeiro.

**Meta do programa:** `provas-sql` de 100–113 para ≤ 80 min de runner por run, e mediana
push→`validate` de ~31 para ≤ 25 min, sem piorar o p90. O Codex rejeitou falsificar só as provas
que o PR tocou, porque perde qualidade.

## Como foi medido

Branch de experimento `claude/exp-provas-medicao-nao-mergear`, que **não mergeou** e foi apagado
depois da medição; nenhum PR foi aberto. A regra de máquina-meta do CLAUDE.md barra instrumentação
permanente sem incidente.

- O shim de `PGBIN_OVERRIDE` do job `provas-sql` ganhou um wrapper em `initdb`, `pg_ctl`, `psql` e
  `createdb`, no PGBIN e no PATH. O wrapper grava uma linha por chamada: prova, binário,
  subcomando, início e duração. O filho roda com stdin explícito e TERM/INT/HUP repassados.
  Nenhuma prova foi editada. O runner só exporta o nome da unidade.
- `vmstat 1` em background durante o step do núcleo.
- Um bench no fim de cada parte: `initdb`, carga do `schema-snapshot.sql`, `CREATE DATABASE …
  TEMPLATE`, `cp -a` de PGDATA parado (vazio e com o snapshot) e start/stop.
- 2 runs por `workflow_dispatch`: **42526943250** e **42529175481**.

**Veredito inalterado.** Nos dois runs, as 7 partes e a `provas-sql-uniao` deram `success`. Foram
as mesmas **311 unidades** do run da main no mesmo commit base (42524463586): 201 normais + 110
`--falsificar`, com as **mesmas contagens** de asserts e sabotagens. O `validate` dos dois runs
caiu num vitest (`bloqueantesOpacos`) que lê o `ci.yml` como texto e não reconhece o step do núcleo
reescrito pela instrumentação. Esse vermelho é do experimento, não das provas.

**Custo da medida.** O wrapper adiciona ~4,6 ms por chamada de `psql` (179 mil por run). O run 1
somou 105,4 min de provas, contra 91,7 na main (+15%). No run 2, que também sonda os processos
irmãos a cada stdin em pipe, o acréscimo foi de +41%. Por isso o run 1 é a base dos números e o
run 2 entra só com o `psql_grande` e o bench. O overhead infla a fatia "teste" e soma CPU, então a
estimativa de CPU ociosa abaixo é **conservadora**.

## (a) Preparação × teste

Run 42526943250, soma do tempo de parede das unidades (serial dentro da parte):

| parte | unidades | parede (min) | initdb | pg start | pg stop | createdb | prep (min) | prep % |
|---|---|---|---|---|---|---|---|---|
| 1 | 41 | 16,0 | 1,68 | 0,45 | 0,42 | 0,56 | 3,1 | 19% |
| 2 | 42 | 13,1 | 1,06 | 0,33 | 0,31 | 0,14 | 1,8 | 14% |
| 3 | 46 | 17,0 | 1,79 | 0,41 | 0,38 | 0,11 | 2,7 | 16% |
| 4 | 47 | 16,1 | 1,96 | 0,54 | 0,51 | 0,16 | 3,2 | 20% |
| 5 | 46 | 12,9 | 1,43 | 0,39 | 0,37 | 0,07 | 2,2 | 17% |
| 6 | 45 | 13,5 | 1,17 | 0,39 | 0,37 | 0,25 | 2,2 | 16% |
| 7 | 44 | 16,7 | 1,31 | 0,36 | 0,34 | 0,34 | 2,3 | 14% |
| **total** | **311** | **105,4** | **10,4** | **2,9** | **2,7** | **1,6** | **17,6** | **17%** |

As chamadas de um run foram 3.193 `initdb`, 1.602 `pg_ctl start`, 1.605 `stop`, 2.458 `createdb` e
~179 mil `psql`. O `initdb` medido custa ~0,2 s por chamada; no bench avulso, 0,31–0,49 s.

**Snapshot.** A maioria das provas carrega o `schema-snapshot.sql` por pipe
(`sed … schema-snapshot.sql | psql`), que um wrapper não consegue atribuir com segurança: a sonda
por processo irmão do run 2 não pegou nada. Os números possíveis são:

- **medido:** 214 cargas por `psql -f` de uma cópia filtrada ≥ 1 MB, somando 3,1 min (run 2);
- **teto:** chamadas de `psql` ≥ 400 ms nas 83 provas cujo fonte cita o snapshot somam 17–19 min.
  Isso é um TETO, porque inclui consultas pesadas de teste;
- **estimativa:** pelo mapa do manifesto, 32 provas carregam o snapshot (187 sabotagens), ou seja,
  ~219 cargas × 0,65–1,14 s (bench) ≈ **3–4 min**.

**Leitura:** a preparação é **~21 min de 105 (≈ 20%)**, com teto de ~35% se o snapshot estiver no
pior caso. Descontado o overhead do wrapper, passa para ~22% de ~92 min. **O resto (~80%) é o
teste em si.**

Top 15 por custo de preparação (s, run 1). Todas são `--falsificar`: 1 cluster por sabotagem.

| unidade | parte | parede | prep | prep % | detalhe |
|---|---|---|---|---|---|
| test-fin-consolidado-ic --falsificar | 4 | 239 | 43 | 18% | initdb 28 · start 8 · stop 7 |
| test-promocao-descricao-fornecedor --falsificar | 1 | 90 | 38 | 43% | createdb 28 · initdb 7 |
| test-reposicao-po-observado --falsificar | 7 | 74 | 34 | 46% | createdb 14 · initdb 13 |
| test-radar-leads-vendedor --falsificar | 1 | 91 | 29 | 32% | initdb 19 · start 5 · stop 5 |
| test-venda-repasse --falsificar | 3 | 214 | 23 | 11% | initdb 15 |
| test-hoje-sp-views-defaults --falsificar | 1 | 315 | 22 | 7% | initdb 14 |
| test-data-health-vendas-empurradas --falsificar | 4 | 99 | 18 | 19% | initdb 11 |
| test-sayerlack-cancelado-com-compra-viva --falsificar | 6 | 160 | 17 | 11% | initdb 7 · createdb 6 |
| test-radar-placar --falsificar | 1 | 49 | 16 | 33% | initdb 11 |
| test-positivacao-eligible-consumo --falsificar | 2 | 54 | 16 | 29% | initdb 9 |
| test-data-health-sayerlack-varredura --falsificar | 4 | 125 | 15 | 12% | initdb 7 · createdb 5 |
| test-padrao-like-contem --falsificar | 3 | 99 | 15 | 15% | initdb 10 |
| test-credito-vinculo-aviso --falsificar | 7 | 43 | 14 | 34% | initdb 9 |
| test-venda-gerador --falsificar | 3 | 60 | 14 | 23% | initdb 10 |
| test-des-simular-puxar-config-checkin --falsificar | 2 | 113 | 14 | 12% | initdb 8 |

As mais longas por parede são quase todas teste puro: `test-hoje-sp-views-defaults --falsificar`
315 s (7% prep), `test-cliente-sucessao-plano --falsificar` 215 s (0%) e
`test-tint-fase5-watchdog` 209 s (0%). A maior unidade, 5,3 min, é o piso de qualquer partição.

## (b) CPU ociosa

`vmstat 1`, núcleos ocupados = (us+sy) × 4 (o `nproc` do runner é 4):

| parte | média | p90 | iowait (núcleos) |
|---|---|---|---|
| 1 | 0,94 | 1,20 | 0,01 |
| 2 | 0,80 | 1,20 | 0,04 |
| 3 | 1,00 | 1,20 | 0,01 |
| 4 | 0,98 | 1,20 | 0,01 |
| 5 | 0,77 | 1,16 | 0,00 |
| 6 | 0,99 | 1,20 | 0,02 |
| 7 | 0,97 | 1,20 | 0,01 |
| **todas** | **0,93** (p50 1,04) | **1,20** | ~0,01 |

O run 2 repete o desenho: média 0,95, p90 1,16. **A parte usa ~1 núcleo de 4 o tempo todo; ~3
ficam ociosos**, e o disco não segura nada (iowait ≈ 0). É o esperado de um runner serial: bash →
psql → 1 backend.

**Ganho estimado de 2 workers.** Pareando segundos aleatórios de cada parte, a demanda somada é
de ~1,9 núcleo em média e ~2,4 no p90, abaixo de 4 em todas as partes. Logo, **pela CPU o teto é
2,0×**. O que pode comer esse ganho não aparece no `vmstat`:

- disputa de memória e cache;
- as 30 provas com `lock_timeout`/`statement_timeout` de 200 ms a 2 s, candidatas a flaky sob carga;
- o piso da maior unidade (5,3 min).

Com um desconto de 20% para isso, fica em ~1,6×.

## (c) Recomendação: **fatia 2 primeiro**

As contas do plano:

- **Fatia 2 (2 workers por runner):** vale acima de 1,4× (7 → 5 partes) e acima de 1,75× (7 → 4).
  O teto pela CPU é 2,0× e o realista é ~1,6–1,9×, então **passa folgado de 1,4× e provavelmente
  de 1,75×**. Com 4 partes × 2 workers, ~92–105 min de provas ÷ 8 trilhas ≈ 12–13 min por trilha,
  acima do piso de 5,3 min. Em minutos de runner, 100–113 caem para **~60–70** (trabalho ÷ ~1,7, mais
  ~1,2 min de setup por parte). **Isso sozinho bate a meta de ≤ 80** e tira 3 jobs da fila de 20 a
  cada run.
- **Fatia 1 (reaproveitar cluster):**
  - Trocar `initdb` por `cp -a` de um PGDATA vazio parado: o bench dá 39 MB, cópia em 0,04–0,07 s
    contra ~0,2 s do `initdb`, o que economiza ~0,15 s × 3.193 ≈ **8 min**. O start/stop continua.
  - Snapshot pré-carregado por cópia de PGDATA: 270 MB, cópia em 0,46–0,92 s contra carga de
    0,65–1,14 s. **Quase não ganha.**
  - Pelo `CREATE DATABASE … TEMPLATE` (0,10–0,17 s), economiza ~0,75 s × ~219 cargas ≈ **3 min**,
    mas exige editar as provas que recarregam por sabotagem.
  - **Total: ~8–11 min de ~92–105, ≈ 1,1×.**
- **Sobreposição:** depois da fatia 2, a economia da fatia 1 cai quase pela metade em minutos de
  runner (~5 min). Ela fica como ajuste fino, a reavaliar com o número medido da fatia 2. Sua parte
  barata e genérica (cópia de PGDATA vazio no lugar do `initdb`, no harness) não toca prova.
- **A fatia 2 precisa provar** com run real:
  - mesmas 311 unidades e mesmas contagens;
  - zero flaky nas 30 provas com timeout curto (rodar 2× antes de baixar o número de partes);
  - portas e diretórios por worker. O runner já dá uma `PGPORT_TEST` por unidade, e nenhuma prova
    escreve na árvore do repo.

## Dados

Artifacts `mede-parte-0..6` dos dois runs (retenção de 7 dias): `chamadas.tsv` (1 linha por
chamada), `provas.tsv` (início e fim de cada unidade), `vmstat.txt` e `bench.txt`. O script de
análise e a instrumentação ficaram só no branch de experimento, já apagado.
