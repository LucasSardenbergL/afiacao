# O `mutation-check` só mede o que o diff alcança (2026-10-01)

> **A classe:** um job **não-required** que cresce com o repo não atrasa o merge pelo próprio
> tempo, e sim pelo **runner que ocupa**. O plano Free roda 20 jobs simultâneos; o que o job
> informativo segura vira fila para os jobs que barram o merge.

## O que foi medido

Medido com `gh run list` e o endpoint de jobs nos runs de 25/09 a 01/10 (21.647 runner-minutos):

| | |
|---|---:|
| fatia do `mutation-check` no tempo de runner do repo | **39%** |
| duração por push de PR em 01/10 (teto do job: 45 min) | 30–43 min |
| PRs (dos 300 mergeados mais recentes) que tocam algum arquivo de contrato | **27%** |
| minutos do job que morreram no teto (76 runs cancelados aos ~25 min), sem veredito | 23% |

O job rodava os 48 contratos `scripts/mutcheck.d/*.mut` **em série** a cada push de PR,
inclusive em PR só de docs. Nesse mesmo período, o push → `validate` (o check required) foi de
6 para 26 min de mediana; nos picos, a fila por runner chegou a 34 min.

## O conserto

Um contrato só muda de veredito quando muda o fonte que ele muta (`# @src:`), o teste que tem de
matar a mutação (`# @test:`), o próprio `.mut`, ou a maquinaria comum. O
[`scripts/mutcheck-escopo.ts`](../../scripts/mutcheck-escopo.ts) cruza o diff do merge commit
(pai 1 → HEAD) com essas diretivas:

- **nenhum contrato alcançado** → o `mutation-check` fica **skipped** (pulado, não verde);
- **alguns** → roda só esses, via `MUTCHECK_DIR` (o mesmo mecanismo do teste do sensor);
- **gatilho global** (`mutcheck.sh`, `mutcheck-all.sh`, o próprio seletor, a prova por consumidor,
  `ci.yml`, `bun.lock`, config e setup do vitest) → **todos**;
- **fora de PR** (push/dispatch na `main`) → **todos**, como antes.

Fail-closed: o script nunca sai ≠ 0; diff ilegível, merge sem 2 pais ou nenhum contrato legível
viram "todos"; contrato sem alvo declarado roda sempre; e o `mutation-check` só pula com
`roda` **explicitamente** `'false'` — se o job de escopo quebrar, ele roda.

## O que fica de fora do escopo (de propósito)

Mudança num arquivo que o teste **importa** mas o contrato não declara (helper de teste
compartilhado, módulo que o `@src` importa) não seleciona o contrato no PR. Quem pega é o run da
`main`, que segue com todos os contratos e abre a Issue `mutcheck-cobertura`. Não há gate
cobrando a lista de gatilhos globais: renomear um deles só tira precisão, e o run da `main`
continua sendo a rede (regra de máquina meta do `CLAUDE.md`).

## Como re-medir

```bash
bun scripts/mutcheck-escopo.ts --base origin/main --head HEAD   # o que este branch rodaria
gh run list --workflow CI --event pull_request --limit 30 --json databaseId,conclusion
```

Na lista de jobs de cada run, o `mutation-check` deve aparecer **skipped** nos PRs fora do
escopo. Nos PRs no escopo, o log do step "Contratos no escopo deste diff" lista cada contrato e o
arquivo que o alcançou.
