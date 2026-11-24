// Testes de COMPORTAMENTO da prioridade por exposição ao atraso de `calculate-scores` (v1.9).
// Sem import remoto: `test:edges` roda com `--no-remote`. As propriedades amplas (2.000 casos semeados)
// vivem no gêmeo vitest (src/lib/scoring/__tests__/prioridadeValor.test.ts); aqui pina-se o espelho.

import { calcularPrioridade, referenciaExposicao } from "./prioridade-valor.ts";
import { prioridadeNoRefreshFatal, prioridadePorStatus } from "./prioridade-historico.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const K = 1000;
const A = 180;

Deno.test("régua: ativo atrasado acima do inativo há 3 anos", () => {
  const atrasado = calcularPrioridade({ status: "ativo", dias: 45, intervalo: 30, gastoMensal: 300 }, K, A)!;
  const inativo = calcularPrioridade({ status: "stale", dias: 1095, intervalo: 30, gastoMensal: 0 }, K, A)!;
  assertEquals(atrasado.faixa, "atrasado");
  assertEquals(inativo.faixa, "reativacao");
  if (!(atrasado.nota > inativo.nota)) throw new Error(`${atrasado.nota} <= ${inativo.nota}`);
});

Deno.test("valores pinados (mesma aritmética do canônico)", () => {
  // E = 3000/30 × 15 = 1500 → 60 + 39,99 × 1500/2500 = 83,994 → 83,99
  assertEquals(calcularPrioridade({ status: "ativo", dias: 45, intervalo: 30, gastoMensal: 3000 }, K, A),
    { nota: 83.99, faixa: "atrasado", exposicao: 1500, diasAlemDaCadencia: 15 });
  // 29,99 × 180/1095 = 4,929... → 4,93
  assertEquals(calcularPrioridade({ status: "stale", dias: 1095, intervalo: null, gastoMensal: 0 }, K, A)?.nota, 4.93);
});

Deno.test("ausente ≠ zero: insumo obrigatório ausente → null, e o null atravessa a regra de status", () => {
  assertEquals(calcularPrioridade({ status: "ativo", dias: 10, intervalo: 5, gastoMensal: null }, K, A), null);
  assertEquals(calcularPrioridade({ status: "sem_historico", dias: null, intervalo: null, gastoMensal: null }, K, A), null);
  assertEquals(prioridadePorStatus("ativo", null), null);
  assertEquals(prioridadeNoRefreshFatal("stale", null, 42), null);
  assertEquals(referenciaExposicao(Number.NaN), 1000);
});
