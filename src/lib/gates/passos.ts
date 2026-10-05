/**
 * Analisador escrito como GERADOR: `yield` nos pontos seguros (entre arquivos, entre migrations),
 * e o resultado no `return`. Uma implementação, dois motoristas:
 *
 *   · `drenar` (aqui) — a CLI e o CI rodam de uma vez, síncrono: o mesmo resultado de antes.
 *   · `drenarCedendo` (`src/test/loop-livre.ts`) — o teste, DENTRO do worker do vitest, drena
 *     cedendo o event loop entre as fatias.
 *
 * Por que o teste não pode drenar de uma vez: o worker do vitest chama o RPC `onTaskUpdate` com
 * timeout fixo de 60s, e um bloqueio síncrono maior que isso (a varredura do repo inteiro sob
 * carga passa) faz o `bun run test` sair rc=1 com ZERO teste falhando
 * (docs/historico/rpc-do-vitest-e-o-loop-preso.md). O gerador não sabe de event loop nenhum —
 * quem decide ceder é o motorista.
 */
export type Passos<R> = Generator<void, R, void>;

/** Roda o gerador até o fim, sem ceder nada — o caminho da CLI. */
export function drenar<R>(passos: Passos<R>): R {
  for (;;) {
    const r = passos.next();
    if (r.done) return r.value;
  }
}
