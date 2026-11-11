# Os jobs de ~6 min fatiados — PRs sem provas SQL (2026-11-11)

> **A classe:** fatiar mais não baixa o piso quando UM alvo é maior que a fatia-alvo. Antes de
> aumentar N, meça o maior alvo indivisível; se ele é o piso, quem tem de ser partido é ele.

## A medição de partida (run 42950648837, PR sem provas SQL)

Com as provas SQL a ~8 min (#3804), o caminho crítico dos PRs **sem** provas virou o empate dos
jobs não-SQL:

| job | s |
|---|---|
| `falsificacao (1)` | 381 — sendo **330 do `codex-async --falsificar` sozinho** (20 rodadas × ~17,7 s em série) |
| `edges-e-build` | 361 — 223 do `sonda:cron-prova --gate` |
| `falsificacao (2)` | 356 — 263 do `fecho-edges-pendentes` |
| `falsificacao (3)` | 335 |
| `gates-e-falsificacao` | 316 — `test:hooks` 136 + falsificação dos evals 68 |

O pedido inicial era "3 → 6 fatias". A medição por alvo (cabeçalho de cada suíte no log) mostrou
que isso só tiraria ~30 s: o `codex-async` sozinho já é 330 s.

## O que mudou

- **`codex-async --falsificar k/N`**: roda o controle inteiro (nos 2 locales) e só as sabotagens de
  posição ≡ k (mod N). A união é o todo por construção; parte malformada sai 64; parte sem
  sabotagem reprova (`FAIL [parte-vazia]`). Sem argumento, roda tudo (laptop e `test:falsificacao`).
  **Por que em runners e não em paralelo no mesmo runner:** o caso `watchdog-sleep-vazado` conta
  `sleep 977` na máquina inteira e o `suite()` recolhe órfãos de qualquer rodada — duas rodadas
  simultâneas se acusariam (vermelho falso) ou matariam o vazamento que a outra precisa ver.
- **Falsificação em 5 fatias** (era 3): `codex-async` 1/2 e 2/2 nas fatias 1 e 2; `fecho-edges-pendentes`
  sozinho na 3 (o novo piso, ~263 s); o resto dividido por tempo medido nas 4 e 5.
  `falsificacao-cobertura.test.ts` passou a provar também que as partes de um alvo partido são
  exatamente 1..N, com o mesmo N, e que ele não está também inteiro num laço.
- **Job `sonda-cron-prova`**: o `sonda:cron-prova -- --gate` saiu do `edges-e-build`.
- **Job `hooks-e-evals`**: `test:hooks` e `evals:deploy-verify:falsificacao` saíram do
  `gates-e-falsificacao`, com o mesmo ambiente (bun, deno, shellcheck pinado).
- Os 2 jobs novos entraram em `validate.needs` e `fail-fast.needs`; `esperados` 8 → 10.
  Nenhum comando mudou, nenhum saiu do `validate`; nada de retry, timeout maior ou teste pulado.

Jobs: +4 por run (2 fatias + 2 jobs). PR com provas: ~29 → ~33 dos 40 simultâneos do GitHub Pro.

## Depois

Medição no próprio PR (#PR) — ver o corpo do PR. Próximo piso: `fecho-edges-pendentes` (263 s);
partir com o mesmo `k/N` só se ele voltar a ser o caminho crítico.
