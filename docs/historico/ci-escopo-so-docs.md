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

Medido no 1º PR só-docs pós-merge (#3830 mergeado em 2026-11-11 15:34 UTC) — este próprio doc é o diff da medição. Números em seguida.
