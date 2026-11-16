# Escopo só-docs nos 7 jobs não-SQL do CI

**Data:** 2026-11-11 · **Programa:** tempo de merge de PR (último item do ranking, depois de #3783, #3804, #3808 e #3817) · **Só CI, sem deploy.**

## Problema

Desde o #3583, um PR só de `docs/` já não roda as provas SQL (`provas-sql-escopo`, modo `inerte`). Os outros 7 jobs, porém, continuavam rodando inteiros: `typecheck`, `testes` (4 shards), `edges-e-build`, `sonda-cron-prova`, `gates-e-falsificacao`, `hooks-e-evals` e `falsificacao` (5 fatias).

## Medição (antes)

PRs mergeados entre 28/10 e 11/11/2026, via `gh pr list --state merged`:

| | |
|---|---|
| PRs mergeados | 400 |
| só `docs/**` | **133 (33%)**, dos quais 132 são só `docs/**/*.md` |
| runs de PR por PR só-docs (amostra) | ~1,1 |

Medi 9 runs de 8 PRs só-docs (#3798–#3818), somando `completed_at − started_at` dos jobs:

| | por run |
|---|---|
| runner dos 7 jobs não-SQL | **2.245–2.517 s** |
| job mais longo (caminho crítico) | **264–434 s** |
| provas SQL | já `skipped` |

São ~146 runs em 14 dias, ou **~90 h de runner** bruto, gastos em jobs que, salvo exceções mapeadas abaixo, não leem `docs/`.

## O mapa: o que nos 7 jobs lê `docs/` ou `*.md`

O mapa foi levantado por subagente (leitura estática; o comportamento do ESLint foi conferido executando) e revisto pelo Codex.

- **`gates-e-falsificacao`**: `claude:size` (`CLAUDE.md`), `docs:indice`, `docs:citacoes`, `docs:links` (todo `.md` rastreado, via `git ls-files`) e `gates:frescura` (lê `docs/agent/deploy.md`). O resto (`exclusividade`, `knip`, `mutcheck-seco`, `lint:shell`, `authz:*`, `bunpin`, `casts`) não lê docs.
- **`edges-e-build`**: só o `eslint .` abre `docs/**/*.mjs`, que fica sem config e é ignorado. Nenhum `.md`.
- **`typecheck`, `sonda-cron-prova`, `hooks-e-evals`, `falsificacao`**: nada. As fixtures de docs são sintéticas, em tmp.
- **vitest**: 6 arquivos leem docs reais em runtime: `edge-money-path-invariants`, `lib/prompt-deploy`, `docs-citacoes-gate-check`, `docs-indice-gate-check`, `authz-carimbo` e `exclusividade-gate`. Outros 2 só mudariam com `.sh` sob `docs/`.

## O desenho

- **`docs-escopo`** (checkout `fetch-depth: 2`, bun sem `install`, `scripts/docs-escopo.ts --evento`) roda em todo evento. Ele só emite `so_docs=true` quando todas as condições abaixo valem; qualquer outra coisa emite `false`:
  - o evento é `pull_request`;
  - o HEAD é o merge sintético (2 pais);
  - o `git diff -z` do pai 1 ao HEAD terminou 0 e veio não-vazio;
  - todo caminho do diff casa `^docs/.+\.md$`.

  A allowlist é estreita de propósito: `.mjs`, `.sql`, `.sh` e `.mut` em `docs/`, ou `CLAUDE.md` e `README.md` na raiz, fazem tudo rodar.
- **Os 7 jobs** têm `needs: docs-escopo` e `if: !cancelled() && !(escopo success && so_docs == 'true')`. Se o escopo falhar, eles rodam.
- **`docs-gates`** roda só quando os 7 pulam. Ele executa os 5 gates acima e o vitest sobre o superconjunto `scripts/docs-escopo.ts --testes`, que é a união de:
  - todo teste do universo do vitest cujo texto cita `docs`, `CLAUDE.md` ou `README.md` (122 de 1.231 arquivos hoje; 93 s de Duration local, 3.622 testes);
  - os 6 leitores conhecidos (`LEITORES_DE_DOCS`), que entram mesmo sem casar o texto. O `authz-carimbo` monta o caminho com `join(RAIZ, 'docs', …)`. Se algum dos 6 sumir, a seleção reprova.
- **`validate`**: `esperados` passa de 10 para 12. Ele aceita `skipped` dos 7 só com evento `pull_request` e `so_docs=true`. Aceita `docs-gates` `skipped` só com `so_docs` diferente de `true`. O próprio `docs-gates` e o `docs-escopo` passam pelo laço como qualquer job, então só `success` passa. A presença dos dois é conferida por nome. O `fail-fast.needs` inclui o `docs-gates`.
- **A rede é a main**: fora de PR, os 7 jobs rodam integralmente. Uma leitura de docs que escape do mapa aparece no run pós-merge.

O step do escopo é **opaco** (`bun ./scripts/…`), pelo mesmo motivo do `provas-sql-escopo`: ele decide escopo e não reprova conteúdo. Os testes que o `--testes` roda já são gate no job `testes`. Os nomes de script do `docs-gates` repetem os do `gates-e-falsificacao`, que vem antes no arquivo e fica como dono no censo (que deduplica por nome).

## 2ª opinião (Codex, gpt-6-astra high, 252 s)

Veredito do Codex: **implementar, com ajustes**. Todos os ajustes entraram:

- superconjunto textual unido aos 6 leitores obrigatórios, e não só os 6;
- escopo em todo evento, devolvendo `false` fora de PR, para o `validate` não ver `skipped` na main;
- `if` com a conjunção completa (`result == success` E saída `true`);
- diff com `-z` e exit conferido;
- testes do agregador atualizados (fixture de 12 jobs em `provas-sql-escopo.test.ts`).

Ressalva registrada pelo Codex: o filtro textual é heurística e não análise de dependência. Quem cobre o resíduo é a main.

## Falsificação

Os testes ficam em `scripts/docs-escopo.test.ts`. Eles executam o step real do `validate` sob cenários de `needs`. Sabotei uma camada por vez, partindo de um commit, com controle verde na mesma invocação:

| camada sabotada | resultado |
|---|---|
| `docs-gates` aceito como pulável no pulo | vermelho |
| pulo fora de `pull_request` | vermelho |
| presença de `docs-escopo` e `docs-gates` | vermelho |
| `esperados` | vermelho |
| `if` dos pesados sem `result == success` | vermelho |
| allowlist `.md` → `docs/` inteiro | vermelho |
| leitor obrigatório ausente | vermelho |

Três camadas ficaram **verdes** e foram removidas por serem redundantes: o laço já reprova `docs-gates` e `docs-escopo` não-`success`. Eram `docs_gates == success` dentro do `docs_pulou` e `docs-escopo == success` nas duas condições.

## Depois

Medido no 1º PR só-docs pós-merge (#3832, run 43054539932; o #3830 mergeou em 2026-11-11 15:34 UTC). O diff do #3832 é este próprio doc. O "antes" são os 9 runs só-docs da medição acima, com a mesma régua: `updated_at − created_at` do run, e a soma de `completed_at − started_at` dos jobs não pulados.

| | antes (9 runs) | depois (#3832) |
|---|---|---|
| parede do run (criação → fim) | 303–534 s (mediana 418) | **177 s** |
| push → `validate` concluído | — | 183 s |
| runner do run inteiro | 2.262–2.543 s | **193 s** |
| runner no lugar dos 7 jobs não-SQL | 2.245–2.517 s | **162 s** (`docs-escopo` 9 + `docs-gates` 153) |

Os 7 jobs vieram `skipped`, e o `validate` aceitou o pulo (`success`). O caminho crítico agora é o `docs-gates`: install, 5 gates e o vitest dos 122 arquivos. O custo para os PRs que não são só-docs foi medido no próprio #3830: `docs-escopo` de ~9 s em série antes dos 7 jobs.

## Fast-path (2026-11-16): `docs-gates` em paralelo e em 3 partes

**Antes** (PR #3897, rodada 6): a cadeia era serial, `docs-escopo` (14 s) → `docs-gates` (124 s) → `validate` (7 s), ou ~131–137 s do push ao `validate`. Dentro do `docs-gates`, o vitest levava 85 s sobre 122 arquivos e 3.632 testes. Só o `scripts/exclusividade-medir.test.ts` levava 55 s: o vitest paraleliza entre arquivos, nunca dentro de um, e esse arquivo era o piso.

Três mudanças. Nenhum teste nem gate saiu do caminho pré-merge: mudou ONDE rodam, não SE rodam.

1. **`docs-gates` sem `needs`.** Cada parte decide o escopo sozinha, no step `escopo`, com o mesmo `scripts/docs-escopo.ts --evento` e o mesmo SHA do `docs-escopo`. Ela roda em paralelo com ele, não atrás. Fora do só-docs, a parte sai verde sem instalar nem testar: todo step depois do `escopo` tem `if: steps.escopo.outputs.so_docs == 'true'`.
   - Problema: o `success` do `docs-gates`, sozinho, deixou de provar que os testes rodaram. Uma parte que discordasse do `docs-escopo` sairia verde sem testar.
   - Correção: o último step de cada parte grava `parte_<i>=rodou`, e só chega lá com tudo verde. No pulo, o `validate` exige as 3 marcas (`rodou,rodou,rodou`). Faltou uma, o pulo não vale e os pesados `skipped` reprovam no laço.
   - Não é sensor novo. É o mesmo invariante que antes vinha do `if: needs.docs-escopo…` ("so_docs=true ⇒ docs-gates rodou"), agora carregado por saída de job. Uma saída por parte, porque a matriz agrega `parte_1..3`, como no exemplo oficial do GitHub de outputs em matriz.
   - O `docs-gates` `skipped` deixou de ser aceito em qualquer cenário: ele não tem mais `if`.
2. **Matriz de 3 partes** (`--testes --parte i/3`, um step estático por parte, como no `testes`).
   - A partição é LPT determinística sobre a mesma seleção (`particionar`). O peso vem de `PESO_SEGUNDOS`, os 16 arquivos lentos; o resto pesa 1.
   - Bytes não servem de proxy: o `sonda-versao-sql`, de 165 KB, leva 12 s; o `mapa-coerente-na-ref`, de 15 KB, leva 27 s.
   - Tabela velha só desbalanceia as partes, nunca tira arquivo.
   - O `docs-escopo.test.ts` prova, na árvore real, que as partes são disjuntas e não-vazias e que a união é a seleção. Prova também que matriz, steps, saídas e `validate` casam no mesmo N.
   - Os 5 gates de docs rodam só na parte 1 (~2 s).
3. **`exclusividade-medir.test.ts` dividido em 4 arquivos.** Os helpers foram para `scripts/exclusividade-medir.fixture.ts` sem mudar lógica, e os helpers do bloco TETO viraram `contextoTeto()`.
   - O TETO é ~39 s de espera de relógio em 5 testes e ficou em 2 arquivos (`-teto-1`, `-teto-2`). O `[fora-da-rodada]` tem o próprio arquivo; o resto, inclusive o `[deps-instaladas]` do `.mut`, fica no original.
   - Medido na M2: 48/48 testes com títulos idênticos (diff vazio). O arquivo mais lento caiu de 86 s para 19,5 s.
   - Não removi o arquivo da seleção por "provar que não lê docs/". O PRONTO exige cobertura idêntica, então cada parte cita este doc e continua no superconjunto textual.

**Cobertura** (M2, as 3 partes rodadas uma a uma): 43 + 40 + 42 = **125 arquivos**, ou seja, os 122 de antes mais as 3 partes novas (`comm` vazio fora delas). São 869 + 1.582 + 1.201 = **3.652 testes**: os 3.632 de antes mais 20 novos do próprio `docs-escopo.test.ts` (40 → 60).

**Falsificação** (commit antes, controle verde 60/60 na mesma invocação, uma camada por vez): todas as 8 camadas ficaram **vermelhas**.
- `validate` ignora as marcas;
- `validate` volta a aceitar `docs-gates` `skipped`;
- a marca perde o `if`;
- o teste da parte 2 perde a condição do escopo;
- `particionar` perde um arquivo;
- `particionar` duplica um arquivo;
- `lerParte` aceita i > N;
- `docs-gates` volta a ter `needs: docs-escopo`.

**Custo para PR que não é só-docs:** 3 jobs a mais, que só fazem checkout, bun e escopo, e saem verdes. O número do run do PR está na tabela abaixo.

### Depois

**Custo para PR com código** (run 43837364380 do #3917): as 3 partes do `docs-gates` duraram 16, 20 e 15 s, ~51 s de runner e 3 vagas de job por PR. Nenhuma ficou no caminho crítico, já que os pesados duram 96–249 s.

**Caminho só-docs:** medido no próprio PR desta seção, o #3918, 1º PR só-docs depois do #3917. É o run 43851634100, com a mesma régua do #3897.

| | antes (#3897) | depois (#3918) |
|---|---|---|
| push → `validate` concluído | 131–137 s | **94 s** (push 10:44:59 → fim do `validate` 10:46:33 UTC) |
| parede do run (criação → fim) | — | 84 s |
| caminho crítico | `docs-escopo` 14 → `docs-gates` 124 → `validate` 7 | `docs-gates (1)` 70 → `validate` 7 (o `docs-escopo`, 8 s, ficou em paralelo) |
| vitest de docs | 85 s num job | 49 / 28 / 43 s nas partes 1/2/3 (Duration do vitest: 48 / 26 / 42 s) |

O `validate` registrou `partes=rodou,rodou,rodou → pulou_pesados=1`. As saídas por parte da matriz agregaram como no exemplo oficial do GitHub.

A cobertura no CI é idêntica à local: 43 + 40 + 42 = **125 arquivos** e 869 + 1.582 + 1.201 = **3.652 testes**.

**Onde ficou o resto (parte 1, 70 s):**
- setup 1 s;
- checkout 8 s;
- bun 1 s;
- install 5 s;
- 5 gates 3 s;
- vitest 49 s, dos quais **collect 22,7 s**: o vitest importa e transforma os 43 arquivos antes de rodar.

Fora dos jobs, o GitHub levou 10 s do push à criação do run, mais 3 s até o 1º job, e 4 s do fim do `docs-gates` ao início do `validate`.

**Ficou em 94 s, não nos ~60 s estimados**, por dois motivos:
1. **Desbalanço das partes.** A parte 2 terminou 21 s antes da 1. Os pesos de `PESO_SEGUNDOS` vieram da M2 sob carga, e o reporter do vitest no CI não imprime duração por arquivo, então não dá para recalibrar só pelo log.
2. **`collect` de ~17–23 s por parte.** É custo fixo de importar os arquivos, e não divide com mais partes.

Rebalancear de verdade daria ~−8 s: as três partes em ~40 s. Exige medir a duração por arquivo no CI, com `--reporter=json` ou similar, e fica fora deste PR.
