# `hooks-e-evals` separado em `hooks` + `evals-falsificacao` (2026-11-11)

> **A classe:** dois steps independentes em SÉRIE no mesmo job somam a parede; quando o job é o
> piso do caminho não-SQL, separar em 2 runners corta o piso para o maior dos dois.

## Dados da decisão
- Programa "piso não-SQL" (Fable + Codex): sonda (#3829) → fecho k/2 (#3835) → **este split** →
  `codex-async` em 3 partes só se ainda for o piso. Teto da leva: +2 runners (este é o 2º).
- Run 43043785156 (sem provas SQL): `hooks-e-evals` **263 s** = `test:hooks` 158 s + falsificação dos
  evals 83 s, em série, mais preâmbulo.

## O que mudou
- `ci.yml`: o job vira `hooks` (só `test:hooks`, com bun/deno/shellcheck pinado) e nasce
  `evals-falsificacao` (só `evals:deploy-verify:falsificacao`, bun + deno — os evals não usam shellcheck).
- O job novo entra no `validate.needs`, no `fail-fast.needs`, no `esperados` (12 → 13) e na lista dos
  pesados que o escopo só-docs pode pular (agora 8). Fixtures: `docs-escopo.test.ts` (PESADOS) e
  `provas-sql-escopo.test.ts` (needs do `validate`).

## Provas
- `docs-escopo.test.ts` / `provas-sql-escopo.test.ts` executam o step REAL do `validate` com os needs
  novos; falsificação (commit antes, controle verde na mesma invocação): job fora do `validate.needs`,
  `esperados` velho, job fora do `case` do só-docs, `if` do só-docs ausente → vermelho.

## Medido
Run do próprio PR (#3837, 43062069811; rodou provas SQL e `mutation-check`, só os não-SQL contam):
`hooks` **170 s** · `evals-falsificacao` **95 s** (antes: `hooks-e-evals` 277 s no 43059927916).
O piso não-SQL passou a ser `falsificacao (1)` 244 s (`codex-async 1/2` + 3 alvos).

**Fila:** neste run vários jobs não-SQL esperaram 40–99 s para começar (no #3835: 3–4 s). O run
disputava runners com 16 partes do `provas-sql` e 3 do `mutation-check` (19–27 min cada), então
ainda não separa o efeito dos 2 runners da leva — quem decide é a amostra n≥5 de PRs SEM provas SQL.

**Incidente no mesmo run (fora do escopo):** 3 partes do `provas-sql` travaram no `apt-get update` do
PGDG até o timeout de 25 min (attempt 1); o `tentar` repete a falha mas nenhuma tentativa tem prazo
próprio, e mirror que TRAVA em vez de falhar segura o job inteiro. Re-run dos falhos passou.
