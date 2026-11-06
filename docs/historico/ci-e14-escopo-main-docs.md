# CI: o dispatch pós-merge pula as provas SQL só com diff cumulativo de `docs/` (2026-11-06, plano v7, lote 5 — E14)

**Substrato:** job `provas-sql-escopo` do `.github/workflows/ci.yml`, `validate`, `auto-merge.yml` · **Sem banco, sem Publish.**

## Problema

O auto-merge dispara o `ci.yml` na main a cada merge (`workflow_dispatch`). Esse run executava as 7 partes do
núcleo e a união mesmo quando o merge era só de docs: ~106 runner-min por run, e é a pior fila do CI. O E1 do
plano v5 ([ci-provas-sql-escopo.md](ci-provas-sql-escopo.md)) já pulava as provas no **PR** só de docs, mas
fora de PR rodava tudo, porque a main é a rede que pega o que escapa do cálculo do PR.

## O desenho (reabertura estreita)

- **Só o dispatch pós-merge.** Ele passa o input `provas_escopo_docs=true`. Push do Lovable, cron diário e
  dispatch manual (default `false`) seguem rodando tudo.
- **Diff CUMULATIVO e só `docs/`.** A allowlist do PR (`src/`, `public/`, `.claude/`) **não** vale na main. O diff
  é `base → github.sha` (o SHA fixo do run, não o HEAD de agora), e um único arquivo fora de `docs/` faz rodar.
- **A base é o run mais recente da main que EXECUTOU as provas**, pela API (`status=completed`, ordem de criação).
  Os runs que não executaram, pulados pelo escopo ou coalescidos, são atravessados. O primeiro que executou
  decide: com as partes `provas-sql (k)` **e** a união em `success`, ele é a base. Senão, não há base. "Workflow
  verde" não serve, porque pode ter as provas puladas.
- **A base tem de ser ancestral do SHA do run** (`git merge-base --is-ancestor`, checkout `fetch-depth: 0` só no
  dispatch). Base desconhecida, não ancestral, igual ao SHA, diff vazio, diff ilegível, API com erro (uma
  re-tentativa) ou página de jobs incompleta: roda tudo.
- **O `validate` só aceita o skip** no dispatch com ref `main`, input `true`, escopo `success`, `roda=false` e a
  `base` em 40 hex que o escopo devolve. O caso do PR não mudou.

Consequência: um merge de código que ainda não foi provado (run vermelho, cancelado ou coalescido) fica dentro do
diff cumulativo e faz o próximo run rodar tudo. O atraso máximo de uma prova sobre a árvore é até o próximo
merge que não seja docs, ou até o cron diário.

## 2ª opinião (Codex)

`scripts/codex-async.sh`, gpt-6-astra max, 431 s, 150.305 tokens, cota em 29%. **Veredito: APROVAR.** Sem
verde-falso concreto. O `validate` real foi executado em 185 cenários, sem bypass. Ele cobriu rerun antigo, run
em andamento, a ordem de criação, `filter=latest`, o push do Lovable, a coalescência e a main vermelha por código.

- **Ressalva aplicada:** um vermelho **sem mudança de código** (relógio, ambiente, prova intermitente) seria
  apagado. O dispatch só de docs seguinte acharia uma base verde mais antiga da mesma árvore e o `validate`
  verde fecharia o `ci-main-red`. Conserto: o 1º run que executou as provas decide. Se ele não ficou verde,
  não há base.
- **P2 aplicado:** os parsers da API (`runsDoCorpo`, `jobsDoCorpo`) viraram funções puras com teste (página
  incompleta, `total_count` ausente, corpo de erro).
- **P3 aplicado:** o comentário da concessão de `docs/` agora diz que uma prova que passe a ler doc tem de tirar
  também o pulo da main.

## Prova

- `scripts/provas-sql-escopo.test.ts`: 94 testes, `exit 0`. Inclui o step REAL do `validate`, extraído do
  `ci.yml` e executado sob 21 cenários de `needs` (controles verdes: PR pulado, dispatch pulado, tudo `success`
  em push/schedule/dispatch).
- **Falsificação** (ritual local, não gate novo): numa worktree destacada do commit, o controle ficou verde
  (94 passed) e depois as **13 sabotagens ficaram vermelhas no teste-alvo, com 0 falhas**, tudo na mesma
  invocação. Sabotagens: aceitar arquivo fora de docs, ignorar a ancestralidade, base = SHA, diff vazio, vermelho
  que não corta a busca, parte não-success, união pulada, página incompleta, CLI sem o input, e no `validate`:
  sem o input, sem a ref, base livre, qualquer evento.
- `bun run typecheck` e `eslint` dos arquivos tocados: `exit 0`.

## Projeção (simulação sobre runs reais, antes do merge)

Script de simulação (scratchpad, não commitado): para cada `workflow_dispatch` da main que executou as provas,
ele aplica `escolherBase` + `decidirMain` (o código final) sobre os runs que **já tinham terminado** quando
aquele run começou (`updated_at < run_started_at`), e a ancestralidade e o diff pelo git local. São 3 páginas da
API, de 2026-10-27 a 2026-11-06.

| | |
|---|---|
| dispatches que executaram as provas | 197 |
| **pulariam** | **34 (17%)** |
| runner-min de partes + união evitados | **3.108,6** (~310/dia; média **91,4** por run elegível) |
| rodam por arquivo fora de `docs/` no diff cumulativo | 160 (140 com base em dispatch, 13 em push, 7 em cron) |
| rodam por base sem provas verdes (o corte do Codex) | 2 |
| rodam por base desconhecida | 1 (o mais antigo da janela, sem run anterior) |

**Por que 17% e não os ~60% do plano ("8 de 13 merges só-docs").** O plano contou PRs, e o desenho conta o
**diff cumulativo** desde a última prova verde. Com a coalescência (1 rodando + 1 pendente), o run de um merge de
docs costuma carregar junto um merge de código que ainda não tinha sido provado. Os commits do Lovable
(`src/integrations/…`, via `push`) também entram no diff. Esse é o preço da invariante: pular só quando a
mesma árvore fora de `docs/` já foi provada. O ganho por run elegível (91,4) bate com a estimativa do plano
(~106 com 6 partes, sem os preâmbulos que continuam).

A fila das partes nos 34 elegíveis (job criado → iniciado) teve p50 de 0,1 min e cauda de 5,5 a 29,3 min. Esses 8
jobs (7 partes + união) por run elegível saem da disputa pelos 20 runners do plano Free.

Uma 1ª passada da simulação morreu num **HTTP 502** da API de jobs. Por isso a produção tem uma re-tentativa no
`gh api`, e na 2ª falha roda tudo.

## Depois (runs reais pós-merge)

Medido nos dispatches reais depois do merge (`gh api …/runs/<id>/jobs` e o log dos jobs `provas-sql-escopo` e `validate`).

| run | SHA | o que houve | decisão |
|---|---|---|---|
| 42224615265 | `38fb6b067` (merge do #3657) | disparado pelo `auto-merge.yml` ANTIGO, sem o input | `fora de PR roda TUDO` (esperado) |
| 42225858927 | `42f76d5ea` (#3658, só docs) | base `38fb6b067` achada e verde; mas entre ela e o run entrou o `af0956dc4` (radar, `db/` + `src/` + migration), cujo run foi coalescido (`cancelled`) | **RODA**: 13 arquivos fora de `docs/` no diff cumulativo. O `validate` mostra `escopo_docs=true … roda=true base=<vazio>` |

A 2ª linha é o desenho funcionando pelo lado seguro: um merge de docs não carimba como provado o código de outro
merge que ainda não foi provado. As amostras de pulo seguem no PR do E17.
