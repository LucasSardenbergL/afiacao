// `bun test` — o runner NATIVO do bun — não é o runner deste repo: o canônico é `bun run test`
// (vitest, sob node). Este arquivo só existe para o `[test] preload` do `bunfig.toml` fazer o
// runner errado FALHAR ALTO, antes de carregar qualquer arquivo de teste.
//
// Por que falhar, e não só tirar o preload: sem ele o `bun test` continua QUASE rodando — aceita
// os imports de `vitest` sem reclamar e fica verde. E verde não prova nada: sob bun, o filho aberto
// sem `env` herda o ambiente da PARTIDA, então o teste de isolamento de
// `scripts/sonda-versao-bump-gate.test.ts` passa SEM isolar. Medição e contexto:
// docs/historico/bun-filho-sem-env-herda-a-partida.md (item M-21 do plano de 2026-09-05).
//
// Por que `process.exit(1)`, e não `throw`: o bun 1.3.14 não aborta num preload que lança — repete
// o erro UMA VEZ POR ARQUIVO de teste e fecha com `Ran N tests across N files`, que se lê como
// execução. O `exit` imprime a mensagem uma vez e sai antes do primeiro arquivo.
//
// Até 2026-09 isto era um shim de `localStorage`/`MediaStream`/`matchMedia` — cópia divergente de
// `src/test/setup.ts`, que é o setup de verdade (achado A9 do mesmo plano).

// Declarado aqui para não depender de os tipos do node entrarem no programa do `tsconfig.app.json`.
declare const process: { exit(code: number): never };

console.error(
  "use bun run test (vitest); bun test não é o runner deste repo — ver docs/historico/bun-filho-sem-env-herda-a-partida.md",
);
process.exit(1);
