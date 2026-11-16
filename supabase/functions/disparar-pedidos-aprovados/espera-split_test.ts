// `eq` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
import { ESPERA_MAX_POR_FILHO_MS, esperaPermitidaMs, ORCAMENTO_ESPERA_TOTAL_MS } from "./espera-split.ts";

function eq(atual: unknown, esperado: unknown, msg: string) {
  if (atual !== esperado) throw new Error(`${msg}: esperado ${esperado}, veio ${atual}`);
}

const T0 = 1_794_826_570_000;

Deno.test("1º filho logo no início: espera cheia de 90 s", () => {
  eq(esperaPermitidaMs(T0, T0 + 1_000), ESPERA_MAX_POR_FILHO_MS, "início");
});

Deno.test("2º filho depois de 90 s de espera: só o que resta do orçamento", () => {
  eq(esperaPermitidaMs(T0, T0 + 92_000), ORCAMENTO_ESPERA_TOTAL_MS - 92_000, "resto");
});

Deno.test("orçamento esgotado: não espera (o caso do 504 de 2026-11-16)", () => {
  eq(esperaPermitidaMs(T0, T0 + 99_000), 0, "sobra < mínimo");
  eq(esperaPermitidaMs(T0, T0 + 140_000), 0, "passou do orçamento");
});

Deno.test("soma das esperas de N filhos nunca passa do orçamento", () => {
  let agora = T0;
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const e = esperaPermitidaMs(T0, agora);
    total += e;
    agora += e + 2_000; // espera inteira + processamento do filho
  }
  if (total > ORCAMENTO_ESPERA_TOTAL_MS) throw new Error(`soma ${total} > orçamento`);
});

Deno.test("relógio inválido: não espera", () => {
  eq(esperaPermitidaMs(Number.NaN, T0), 0, "inicio NaN");
  eq(esperaPermitidaMs(T0, Number.NaN), 0, "agora NaN");
});
