# "Exigir branch atualizada" antes do auto-merge (E3, opção C): medido e NÃO vale

**Data:** 2026-11-16 · **Lote:** 9 do plano v5 (E3), reaberto para avaliar a opção C sem merge queue.
**Decisão:** não implementar. Nenhum workflow mudou. Antecedente: [ci-merge-queue-bloqueada-repo-pessoal.md](ci-merge-queue-bloqueada-repo-pessoal.md).

## A proposta

O `auto-merge.yml` só faria o squash se a branch do PR contivesse a main atual (o `validate` teria
passado sobre `main + PR`). Se estivesse atrás, o workflow chamaria
`PUT /repos/{o}/{r}/pulls/{n}/update-branch` e esperaria o CI novo. Opcionalmente, o founder ligaria
`strict: true` ("Require branches to be up to date before merging") na proteção da `main`, que já
existe (`contexts: ["validate"]`, `strict: false`, lido em 2026-11-16).

**Obstáculo de plataforma, conferido na doc oficial** (`docs.github.com/.../security/github_token`):
eventos disparados pelo `GITHUB_TOKEN` não criam workflow run, com exceção de `workflow_dispatch` e
`repository_dispatch`. Para `pull_request` `synchronize` gerado pelo token, a doc atual diz que o run
nasce em estado *approval-required* e só anda com o clique de alguém com write. Então o update-branch
feito pelo token não roda o CI sozinho. O único contorno sem credencial nova é o workflow chamar
`gh workflow run ci.yml --ref <branch-do-PR>` depois do update; o `validate` desse run cai no head SHA
e satisfaz o required check. Nesse evento o `provas-sql-escopo` roda TUDO (fail-closed para evento
≠ `pull_request`), e os gates de diff só-PR não rodam, então cada re-run custa mais que o run de PR.

## Medição (02/11 18:30Z → 16/11, 14 dias)

Fontes: `gh pr list --state merged` (352 PRs; 338 com run de CI de PR identificável), `actions/runs`
do workflow CI por dia (1.195 runs), jobs de cada run, `git log --first-parent origin/main`.
Scripts em [dados/e3-branch-atualizada/](dados/e3-branch-atualizada/).

**Carga.** Pico de 7–8 merges por hora (13/11 22h, 11/11 12h–18h). CI de PR, do `created_at` ao fim
(inclui fila): mediana 18 min, p80 30.

**Quantos PRs estavam atrás no merge.** 200 de 338 (59%): entrou ≥1 commit na main entre a criação
do último run de CI do PR e o merge dele. Mediana de 1 commit, máximo 26.

**Runner-min por run de PR** (soma dos jobs, cada um arredondado para cima no minuto):

| PR | n | mediana | média |
|---|---|---|---|
| só `docs/`/`*.md` | 120 | 45 | 53 |
| toca `src/`, `supabase/`, `db/`, `scripts/` ou config | 216 | 148 | 139 |
| todos | 338 | — | 109 |

**Simulação de eventos discretos** sobre os 338 PRs, com os merges do bot do Lovable fixos no horário
real. "Atraso" é o tempo a mais até o merge em relação ao real. "Sem prova" é merge que estourou o
teto de updates e entrou atrás.

| Variante | Política | Teto | Re-runs | Sem prova | Atraso médio | p90 |
|---|---|---|---|---|---|---|
| todo PR | atualiza todos em paralelo | ∞ | 885 | 0 | +116 min | +296 |
| todo PR | só o mais antigo pronto (serial) | ∞ | 265 | 0 | +722 min | +3.466 |
| PR **e** delta da main tocam código/config | serial | ∞ | 150 | 0 | +370 min | +621 |
| PR **e** delta da main tocam código/config | paralelo | 1 | 109 | 74 | +13 min | +36 |
| PR **e** delta não são só docs | serial | ∞ | 151 | 0 | +382 min | +687 |

A variante mais barata que ainda prova todo merge custa ~150 × 139 ≈ **21.000 runner-min em 14 dias**
e +6 h de atraso médio por PR. Com teto, fica mais barata, mas deixa dezenas de merges sem prova, ou
seja, não previne o incidente. Os números são **piso**: o modelo não põe os re-runs na fila de 20 jobs
do plano Free (que já é o gargalo, `ci-fila-de-runners.md`), e o re-run via dispatch roda as provas
SQL inteiras.

**Episódios de main vermelha depois de 02/11: 12. Nenhuma combinação de PRs identificada.**

| Classe | Episódios | Exemplos (evidência) |
|---|---|---|
| Push direto do bot do Lovable na main | 7 | `7155ae593` "Lovable update" (só `types.ts`), `12c0a9392` e `0b5287a44` "Work in progress" (`types.ts`), `6c3b025f4`/`75952e848`/`ccfd57391` (devDeps `@lovable.dev/*` → knip) |
| Flaky, infra ou tempo | 5 | 504 baixando Deno/shellcheck (05/11, 2×); race no teste `voltar-fecha-detalhe` do #3720 (08/11, 2×, verde e vermelho alternando sem mudança); PG 17.11 → 17.12 no runner (12/11: o mesmo sha `477a5d478` verde no run 43202257011 e vermelho no 43270643595, conserto #3877); fixture ancorada em `now()` vencida (15/11, conserto #3906) |
| Combinação de dois PRs verdes | **0** | — |

A classificação foi feita por subagente com evidência por run/sha/PR. Conferi à parte que os 4 commits
do bot citados são de `gpt-engineer-app[bot]` e que o run 43202257011 é verde no mesmo sha do ep. de 12/11.
Checagem cruzada: os 22 runs vermelhos da main desde 03/11 falharam só em jobs cujo erro está na
tabela (`gates-e-falsificacao` ×10, `provas-sql` ×6, `testes` ×5, `typecheck` ×2). Uma segunda causa
dentro do MESMO job e da mesma janela vermelha não estaria visível; por isso "nenhuma identificada",
não "ausência provada".

## Conta

- Incidente de referência: ≈670 runner-min e ~2h50 de main vermelha por episódio de combinação.
- Frequência observada da classe depois de 02/11: 0 em 14 dias (1 episódio em 01–02/11).
- Custo da regra na variante mais barata que prova todo merge: ~21.000 runner-min e +6 h de atraso
  médio por PR em 14 dias, ~30× o custo de um episódio. O empate pediria ~30 episódios de combinação
  a cada 14 dias.
- A regra não pega nenhum dos 12 episódios reais: os 7 do bot entram por push direto, fora de qualquer
  regra de PR, e os 5 flaky não dependem da base.

## 2ª opinião (Codex, gpt-6-astra, reasoning high, 138 s)

**Concordou** com não implementar. Três correções, já incorporadas acima ou aqui:

1. Com `strict: false` a regra não previne de fato: dois PRs podem conferir a mesma main, passar, e o
   segundo segue com auto-merge armado depois que o primeiro entra. Serializar o job que arma o
   `--auto` não serializa os merges, e `--match-head-commit` protege o head, não a base. Ou seja,
   `strict: true` seria **obrigatório**, não opcional.
2. O contorno via dispatch não está provado de ponta a ponta. A doc do GitHub
   (`troubleshooting-required-status-checks`) diz que checks de `workflow_dispatch` não contam como
   required check em **rulesets**; na proteção clássica, que é a nossa, não foi testado. E o
   `ci-na-main-pos-merge` só aceita CI de `pull_request` (`auto-merge.yml`), então um merge liberado
   por run de dispatch ficaria sem o CI pós-merge sem adaptar a associação run → PR.
3. A base pelo `created_at` do run é aproximação: para a regra literal ("a branch contém a main"),
   tende a **subestimar** quantos PRs precisariam de update. Não inverte a decisão.

## Reabrir quando

- Houver ≥2 episódios de **combinação comprovada** (PR culpado com `validate` verde sobre base que não
  continha o PR conflitante) em 30 dias. A query é a mesma dos scripts.
- Ou o repo virar de organização: aí a merge queue nativa é a saída, e o mapa de `merge_group` está no
  doc antecedente.

## A alavanca que os dados apontam

7 de 12 episódios vieram do push direto do bot do Lovable na main: regeneração do
`src/integrations/supabase/types.ts` que remove assinatura ainda usada, e devDeps `@lovable.dev/*` que o
knip reprova. Nenhuma regra de PR alcança esse caminho. Fica como candidato próprio, fora do E3.
