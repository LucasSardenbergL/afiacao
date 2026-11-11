# vitest do CI em 4 shards (2026-11-11)

> **A classe:** depois de partir o maior alvo indivisível (#3808), o job seguinte a colar no piso
> era o `testes` — e esse É divisível: o `--shard=k/N` do vitest parte por arquivo. Subir N custa
> só o preâmbulo fixo (~16 s) por runner a mais.

## A medição de partida (runs 43015374913 e 43014080499, PRs sem provas SQL)

| job | s (job) | vitest | fim (do createdAt) |
|---|---|---|---|
| `testes (1)` | 204 / 300 | — / 282 | 207 / 304 |
| `testes (2)` | 196 / 270 | — / 252 | 199 / 273 |
| `falsificacao (3)` | 253 / 258 | | 256 / 262 |
| `falsificacao (1)` | 248 / 243 | | 251 / 246 |

Preâmbulo do job `testes` (set up + checkout + bun + install): ~16 s. No 2º run o `testes (1)`
(304 s) era o caminho crítico, 42 s acima do `falsificacao (3)`.

## O que mudou

- `test:shard:1..4` = `vitest run --shard=k/4`; a matriz `shard: [1, 2, 3, 4]` do MESMO job
  `testes` (um step estático por shard, `if: matrix.shard == k`). Mesmo nome de matriz →
  `validate.needs`/`esperados` intactos; +2 runners.
- `scripts/vitest-shards.test.ts`: prova estática de que os scripts são 1..N, todos com o MESMO N,
  a matriz é exatamente 1..N, um step por shard casado com o `if`, e `testes` segue no `needs` do
  `validate`. Shard faltando ou N divergente = arquivos de teste que nunca rodam no CI.
- `test:shard:3`/`:4` registrados em `scripts/exclusividade-matriz.json` (dispensados, mesmo motivo);
  censo de `docs/agent/deploy.md` 38 → 40.

Nada pulado, sem retry, sem timeout maior: a união dos 4 shards é a suíte inteira.

## Depois (run do próprio PR)

Ver o corpo do PR — caminho crítico não-SQL medido do `createdAt` do run ao `completedAt` do último
job não-SQL.
