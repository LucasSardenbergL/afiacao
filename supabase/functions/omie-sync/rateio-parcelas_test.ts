// Testa o rateio REAL de parcelas-os.ts (PR 2.1, rodada 3 do Novo Pedido) no runtime Deno.
// Roda com: deno test --no-remote supabase/functions/omie-sync/rateio-parcelas_test.ts
//
// O defeito que isto fecha: a última parcela era calculada em REAIS inteiros, e R$ 100 em 3 vezes ia ao
// Omie como 33,33 + 33,33 + 34,00 = R$ 100,66. Os valores esperados abaixo foram contados à mão.
import { ratearTotalEmParcelas } from "./parcelas-os.ts";

function igual(veio: number[], esperado: number[], ctx: string) {
  if (JSON.stringify(veio) !== JSON.stringify(esperado)) {
    throw new Error(`${ctx}: esperava ${JSON.stringify(esperado)}, veio ${JSON.stringify(veio)}`);
  }
}
const somaCentavos = (v: number[]) => v.reduce((s, x) => s + Math.round(x * 100), 0);

Deno.test("R$ 100 em 3: 33,33 + 33,33 + 33,34 (era 34,00 → R$ 100,66)", () => {
  igual(ratearTotalEmParcelas(100, 3), [33.33, 33.33, 33.34], "100/3");
});

Deno.test("1 parcela: o total inteiro", () => {
  igual(ratearTotalEmParcelas(403.2, 1), [403.2], "403,20/1");
});

Deno.test("2 parcelas com centavo ímpar: o saldo vai na última", () => {
  igual(ratearTotalEmParcelas(100.01, 2), [50, 50.01], "100,01/2");
});

Deno.test("7 parcelas de total quebrado: 6 × 14,28 + 14,31", () => {
  igual(ratearTotalEmParcelas(99.99, 7), [14.28, 14.28, 14.28, 14.28, 14.28, 14.28, 14.31], "99,99/7");
});

Deno.test("total menor que n centavos não quebra: 0,02 em 3 → 0 + 0 + 0,02", () => {
  // Parcela zero é o que a matemática dá; o Omie exige nValor > 0, mas OS de 2 centavos em 3x não existe.
  igual(ratearTotalEmParcelas(0.02, 3), [0, 0, 0.02], "0,02/3");
});

Deno.test("propriedade: para todo total em centavos e n de 1 a 12, a soma é o total ao centavo", () => {
  // Varredura determinística (sem dependência remota): totais de 0,01 a 2.000,00 em passos primos.
  for (let c = 1; c <= 200_000; c += 97) {
    for (let n = 1; n <= 12; n++) {
      const v = ratearTotalEmParcelas(c / 100, n);
      if (v.length !== n) throw new Error(`c=${c} n=${n}: ${v.length} parcelas`);
      if (somaCentavos(v) !== c) throw new Error(`c=${c} n=${n}: soma ${somaCentavos(v)} ≠ ${c}`);
      for (const x of v) {
        if (Math.round(x * 100) / 100 !== x) throw new Error(`c=${c} n=${n}: ${x} não é centavo exato`);
      }
      // Só a última pode diferir, e por menos de n centavos.
      const delta = Math.round(v[n - 1] * 100) - Math.round(v[0] * 100);
      if (delta < 0 || delta >= n) throw new Error(`c=${c} n=${n}: saldo fora de [0, n): ${delta}`);
    }
  }
});

Deno.test("float de entrada: 0,1 + 0,2 (0,30000000000000004) rateia como 0,30", () => {
  igual(ratearTotalEmParcelas(0.1 + 0.2, 3), [0.1, 0.1, 0.1], "0,3/3");
});

Deno.test("entrada inválida LANÇA (total ≤ 0, NaN, n < 1, n fracionário) — nunca inventa parcela", () => {
  for (const [t, n] of [[0, 1], [-5, 2], [NaN, 2], [Infinity, 1], [100, 0], [100, 1.5]] as const) {
    let msg = "";
    try { ratearTotalEmParcelas(t, n); } catch (e) { msg = (e as Error).message; }
    if (!msg.startsWith("ratearTotalEmParcelas: ")) throw new Error(`(${t}, ${n}) não lançou a marca: "${msg}"`);
  }
});
