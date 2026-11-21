// Comportamento da base de vendas de calculate-scores v1.8 (sentinela 999/R$0 → NULL).
// Sem import remoto: `test:edges` roda com `--no-remote`.

import { componenteMeta, deriveSalesBase, finitoOuNulo, tetoGasto } from "./base-vendas.ts";
import { componenteRecompra, scoreFrequencia } from "./frequencia-recompra.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(msg ?? `assertEquals falhou: ${ja} !== ${jb}`);
}

Deno.test("[BASE-VENDAS] sem linha na RPC (nunca comprou) → dias NULL e gasto NULL, nunca 999/0", () => {
  const esperado = { days_since_last_purchase: null, avg_monthly_spend_180d: null, category_count: 0 };
  assertEquals(deriveSalesBase(undefined), esperado);
  assertEquals(deriveSalesBase(null), esperado);
});

Deno.test("[BASE-VENDAS] zero MEDIDO preservado (stale sem venda na janela de 180d)", () => {
  assertEquals(deriveSalesBase({ days_since_last_purchase: 183, revenue_180d: 0, category_count: 2 }), {
    days_since_last_purchase: 183,
    avg_monthly_spend_180d: 0,
    category_count: 2,
  });
});

Deno.test("[BASE-VENDAS] 999 MEDIDO preservado — a regra é a FONTE, não o valor", () => {
  assertEquals(deriveSalesBase({ days_since_last_purchase: 999, revenue_180d: "0", category_count: 3 }).days_since_last_purchase, 999);
});

Deno.test("[BASE-VENDAS] pedido grátis hoje: 0 dias e R$0 medidos ficam (não vira NULL por status)", () => {
  assertEquals(deriveSalesBase({ days_since_last_purchase: 0, revenue_180d: 0, category_count: 1 }), {
    days_since_last_purchase: 0,
    avg_monthly_spend_180d: 0,
    category_count: 1,
  });
});

Deno.test("[BASE-VENDAS] lixo na linha → NULL (Number('') e Number(null) seriam 0)", () => {
  assertEquals(deriveSalesBase({ days_since_last_purchase: "", revenue_180d: null, category_count: null }), {
    days_since_last_purchase: null,
    avg_monthly_spend_180d: null,
    category_count: 0,
  });
  assertEquals(finitoOuNulo(NaN), null);
  assertEquals(finitoOuNulo("7"), 7);
});

Deno.test("[BASE-VENDAS] meta: gasto não medido → null; 0 medido → 0", () => {
  assertEquals(componenteMeta(null, 500), null);
  assertEquals(componenteMeta(0, 500), 0);
  assertEquals(componenteMeta(250, 500), 50);
});

Deno.test("[BASE-VENDAS] teto do gasto idêntico ao v1.7 (NULL no lugar do 0 sentinela)", () => {
  const v17 = (xs: number[]) => Math.max(...xs.map((x) => Number(x || 0)), 1);
  assertEquals(tetoGasto([null, 0, 37, 4200]), v17([0, 0, 37, 4200]));
  assertEquals(tetoGasto([null, null]), 1);
});

Deno.test("[BASE-VENDAS] sem linha ⇒ intervalo null: frequência e recompra já eram null com 999 (compute inalterado)", () => {
  // Quem não tem linha na RPC também não tem intervalo medido; com 999 ou com NULL os dois componentes
  // saem do score — por isso health/priority de ninguém mudam pela troca.
  assertEquals(scoreFrequencia(null, 30, 999), null);
  assertEquals(scoreFrequencia(null, 30, null), null);
  assertEquals(componenteRecompra(999, null), null);
});
