# falsificação do `fecho-edges-pendentes` partida em k/2 (2026-11-11)

> **A classe:** mesma do `codex-async` (#3808). Um alvo de falsificação que roda SÓ numa fatia
> vira o piso do caminho não-SQL, e mais fatias não o movem: o tempo é do alvo, não da fatia.
> Partir as SABOTAGENS por posição entre runners (controle inteiro em cada um) move.

## Dados da decisão
- Programa "piso não-SQL" (Fable + Codex, independentes): sonda (#3829) → **fecho k/2** → split do
  `hooks-e-evals` → `codex-async` 3 partes só se ainda for o piso. Teto: +2 runners na leva.
- Run de referência pós-#3829 (43043785156, sem provas SQL): `falsificacao (3)` **292 s** (só o
  `fecho-edges-pendentes --falsificar`) — o maior job do run.

## O que mudou
- `scripts/test-fecho-edges-pendentes.sh --falsificar [k/N]`: roda o CONTROLE inteiro (2 locales) e
  as travas de forma da lista (`SABOTAGENS` repetida, `|`, registro órfão) em TODA parte, e só as
  sabotagens de posição p com `(p-1) % N + 1 == k`. União = todo por construção; sem argumento roda
  tudo (laptop e `test:falsificacao`). Parte malformada sai 64; parte que não sabota nada reprova
  `FAIL [parte-vazia]`.
- `package.json`: `test:falsificacao:3` = `--falsificar 1/2`; `test:falsificacao:6` (nova) = `2/2`.
- `ci.yml`: matriz `parte: [1..6]` + step `if: matrix.parte == 6`. +1 runner.
- `exclusividade-matriz.json` (fatia 6 dispensada como as outras) e censo de gates em `deploy.md` (41).

## Provas
- `falsificacao-cobertura.test.ts` já entendia alvo partido (`partesFalsificadas`): partes 1..N com o
  mesmo N, nenhum alvo partido E inteiro, step casado com a parte, a suíte lê `$2` e reprova parte vazia.
- Falsificação da mudança (controle verde na mesma invocação, commit antes): sem o script da fatia 6,
  `if` trocado, matriz sem o 6, parte duplicada, sem `FAIL [parte-vazia]`, sem o parser `k/N` → vermelho.
- Local: `--falsificar 1/2` e `2/2` verdes; a união das sabotagens julgadas = as do modo sem argumento.

## Medido
_preenchido no PR (run do próprio PR)._
