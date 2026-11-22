// Testa o CÓDIGO REAL de estoque-desconhecido.ts no runtime real (Deno) e, em texto, que os
// call-sites das edges leitoras usam o helper em vez de fabricar 0 a partir de `null`.
// Roda com: deno test --allow-read=supabase/functions supabase/functions/_shared/estoque-desconhecido_test.ts
import {
  classificarEstoque,
  escolherContaPorEstoque,
  lerEstoque,
  rotuloEstoqueCurto,
  rotuloEstoquePrompt,
  semSaldoConhecido,
} from "./estoque-desconhecido.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

Deno.test("lerEstoque — null/undefined/'' são desconhecidos, nunca 0", () => {
  assertEquals(lerEstoque(null), null);
  assertEquals(lerEstoque(undefined), null);
  assertEquals(lerEstoque(""), null);
  assertEquals(lerEstoque(0), 0);
  assertEquals(lerEstoque("7.5"), 7.5);
});

Deno.test("classificarEstoque — positivo, desconhecido e zero (negativo conta como zero)", () => {
  assertEquals([5, null, 0, -2].map(classificarEstoque), ["positivo", "desconhecido", "zero", "zero"]);
});

Deno.test("recommend — só saldo SABIDAMENTE <= 0 descarta; desconhecido segue candidato", () => {
  assertEquals(semSaldoConhecido(null), false, "estoque desconhecido não pode descartar o produto");
  assertEquals(semSaldoConhecido(undefined), false);
  assertEquals(semSaldoConhecido(0), true);
  assertEquals(semSaldoConhecido(-1), true);
  assertEquals(semSaldoConhecido(3), false);
});

Deno.test("prompt — desconhecido vira 'estoque desconhecido', nunca 'Estoque:0'", () => {
  assertEquals(rotuloEstoquePrompt(null), "estoque desconhecido");
  assertEquals(rotuloEstoquePrompt(0), "Estoque:0");
  assertEquals(rotuloEstoquePrompt(12), "Estoque:12");
  assertEquals(rotuloEstoqueCurto(null), "desconhecido");
  assertEquals(rotuloEstoqueCurto(4), "4");
});

Deno.test("escolha de conta — positivo > desconhecido > zero; menor saldo entre positivos", () => {
  // (atual, outra) → resultado
  const casos: Array<[unknown, unknown, "atual" | "outra"]> = [
    [10, 3, "outra"], // menor saldo positivo vence (regra antiga preservada)
    [3, 10, "atual"],
    [5, 5, "atual"], // empate mantém a escolha da IA
    [10, null, "atual"], // desconhecido NÃO vence como se fosse 0 (era o bug: 0 < 10)
    [null, 4, "outra"], // conhecido > 0 vence desconhecido
    [null, null, "atual"],
    [0, null, "outra"], // desconhecido vence zero real
    [null, 0, "atual"], // zero real não vence desconhecido
    [0, 7, "outra"], // positivo vence zero real
    [7, 0, "atual"],
    [0, 0, "atual"],
    [-3, null, "outra"],
  ];
  for (const [a, o, esperado] of casos) {
    assertEquals(escolherContaPorEstoque(a, o), esperado, `atual=${a} outra=${o} → esperado ${esperado}`);
  }
});

// ── Call-sites: as edges leitoras não podem voltar a fabricar 0 de `estoque` ──
const LEITORES = ["../recommend/index.ts", "../analyze-unified-order/index.ts"];
const FABRICA_ZERO = /\bestoque\s*(\?\?|\|\|)\s*0\b/;

Deno.test("call-sites — recommend e analyze-unified-order não convertem estoque null em 0", async () => {
  for (const rel of LEITORES) {
    const fonte = await Deno.readTextFile(new URL(rel, import.meta.url));
    const linha = fonte.split("\n").find((l) => FABRICA_ZERO.test(l));
    assertEquals(linha ?? null, null, `${rel} ainda fabrica 0 a partir de estoque: ${linha}`);
    assertEquals(fonte.includes('from "../_shared/estoque-desconhecido.ts"'), true, `${rel} não usa o helper`);
  }
});
