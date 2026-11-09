# Merge queue (E3 do plano v5): bloqueada pela plataforma — o repo é de conta pessoal

**Data:** 2026-11-04 · **Lote:** 9 do plano v5 (`docs/superpowers/plans/2026-11-03-plano-melhoria-v5/README.md`, §2 E3 e §4)
**Decisão do founder:** fechar como bloqueado (opção D). A rede atual continua; nenhum workflow mudou.

## O incidente que motivava

A main ficou vermelha ~2h50 em 01/11 e 02/11 (#3498/#3539): dois PRs verdes ISOLADAMENTE quebraram
juntos, e 5 PRs seguintes falharam no `typecheck` em arquivo que não tocaram (≈670 runner-min). A
merge queue validaria o PR contra a main COMBINADA antes de entrar, e o próprio `ci.yml` (comentário
do gatilho `schedule`) já a apontava como a solução "melhor".

## Por que não dá

- A fonte oficial (`github/docs`, `data/reusables/gated-features/merge-queue.md`) diz: *"Pull request
  merge queues are available in any public repository owned by an organization, or in private
  repositories owned by organizations using GitHub Enterprise Cloud."*
- `gh api repos/LucasSardenbergL/afiacao` → `owner.type = "User"`, `visibility = "public"`. Conta
  pessoal não é organização, então o ruleset de `main` nem oferece "Require merge queue".
- Estado lido em 2026-11-04: `rulesets = []`; proteção clássica da `main` com
  `required_status_checks.contexts = ["validate"]`, `strict: false`, sem review obrigatório.

## Alternativas avaliadas

| Opção | Veredito |
|---|---|
| A) Transferir o repo para uma org gratuita | **Não agora.** Destrava a fila nativa, mas o GitHub App do Lovable e o sync bidirecional (o caminho do Publish) precisam ser reconectados. Guias de terceiros dizem que transferir quebra o sync e que o Lovable pode exigir repo novo. É risco de deploy para evitar ~2h50 de main vermelha. |
| B) Fila de terceiro (Mergify, Trunk) | Não adotada: App externo com grant OAuth, dependência nova. |
| C) "Require branches to be up to date" (`strict: true`) | **Inviável:** quem atualizaria o branch é o `GITHUB_TOKEN`, e push do token não dispara CI (anti-loop do GitHub). Todo PR travaria esperando um `validate` que nunca roda. |
| D) Fechar o E3 e manter a rede atual | **Escolhida.** CI na main após cada merge (`auto-merge.yml`, job `ci-na-main-pos-merge`) + cron diário 09:17 UTC + Issue `ci-main-red`. |

**Reabrir quando:** o repo passar a ser de organização (por outro motivo) ou o incidente se repetir
com custo maior que o do episódio de 01–02/11.

## Mapa do CI para `merge_group` (vale se o repo virar de org)

Levantado sobre o `ci.yml` em `1514eb7a5`, para não refazer a leitura das 2.000 linhas:

- **`concurrency`:** `merge_group` cai em `ci-merge_group-<run_id>`, sem cancel. OK sem mudança.
- **Gates de DIFF `pull_request`-only** (`sonda:bump`, `sonda:nova`, `sonda:fanout`, `canaria:bump`):
  ficam só no PR. A fila só aceita PR com `validate` verde no próprio head, então eles já rodaram; na
  fila sobram os gates de ESTADO, que são os que pegam a combinação.
- **`mutcheck-seco-gate`:** `github.base_ref` vem vazio no `merge_group` → `origin/main`; com
  `fetch-depth: 0`, `merge-base` = ponta da main. Funciona.
- **`provas-sql-escopo` e `mutcheck-escopo`:** evento ≠ `pull_request` → roda TUDO (fail-closed). O
  `validate` só aceita `provas-sql` skipped com `EVENTO=pull_request`. Coerente.
- **`mutation-check`** (informativo, ~56 min de runner): PRECISARIA de exclusão explícita de
  `merge_group` no `mutcheck-escopo` **e** no próprio job, porque o `if` dele usa `!cancelled()` e
  rodaria mesmo com o escopo pulado (saída vazia ≠ `'false'`).
- **`ci-main-red`, `authz-sentinela`, `mutcheck-sensor`:** exigem `github.ref == refs/heads/main`; na
  fila a ref é `gh-readonly-queue/main/...`, então não rodam. OK.
- **`auto-merge.yml`:** `gh pr merge --auto --squash` já enfileira quando a fila existe. O
  `ci-na-main-pos-merge` espera ~10 min pelo `MERGED`; com a fila o merge chega depois de um CI
  inteiro, então ele queimaria ~10 min de runner ocioso por PR. Ele teria de detectar a regra
  `merge_queue` (`gh api repos/$REPO/rules/branches/main`) e não disparar.
- **Não verificado (precisa de prova empírica com a fila ligada):** se o merge da fila gera `push` na
  main (há relato de que não) e se o `merge_group` dispara quando quem enfileirou foi o
  `GITHUB_TOKEN`.

## Efeito colateral no plano

O corte E2 ("tirar `provas-sql` do dispatch pós-merge") dizia "reavaliar só depois de E1/E3". Com o
E3 fechado, o dispatch pós-merge continua sendo a ÚNICA validação da combinação antes do cron. O E2
fica cortado.
