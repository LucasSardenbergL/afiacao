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
import { escolherContaPorQuantidade } from "../analyze-unified-order/escolha-conta.ts";

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

Deno.test("escolha de conta por QUANTIDADE — cobre o pedido > parcial > desconhecido > zero", () => {
  // (atual, outra, quantidade) → resultado
  const casos: Array<[unknown, unknown, unknown, "atual" | "outra"]> = [
    [3, 10, 5, "outra"], // Codex P2 no #4095: 3 não cobre 5, 10 cobre
    [10, 3, 5, "atual"], // a regra antiga trocava para a de 3, que não cobre
    [10, 6, 5, "outra"], // as duas cobrem: vence o MENOR saldo (esvaziar o lote menor)
    [6, 10, 5, "atual"],
    [5, 8, 5, "atual"], // saldo == quantidade cobre
    [2, 4, 5, "outra"], // nenhuma cobre: vence o MAIOR saldo (cobrir o máximo)
    [4, 2, 5, "atual"],
    [4, 4, 5, "atual"], // empate mantém a escolha da IA
    [null, 3, 5, "outra"], // parcial conhecido vence desconhecido
    [null, 10, 5, "outra"],
    [10, null, 5, "atual"],
    [0, null, 5, "outra"], // desconhecido vence zero real
    [null, 0, 5, "atual"],
    [0, 2, 5, "outra"], // parcial vence zero real
    [null, null, 5, "atual"],
    [0, 0, 5, "atual"],
  ];
  for (const [a, o, q, esperado] of casos) {
    assertEquals(escolherContaPorQuantidade(a, o, q), esperado, `atual=${a} outra=${o} qtd=${q} → esperado ${esperado}`);
  }
});

Deno.test("escolha por quantidade — quantidade ausente/inválida degrada para a regra por saldo", () => {
  for (const q of [undefined, null, "", 0, -2, Number.NaN, "abc"]) {
    for (const [a, o] of [[10, 3], [3, 10], [10, null], [0, null], [5, 5]] as Array<[unknown, unknown]>) {
      assertEquals(
        escolherContaPorQuantidade(a, o, q),
        escolherContaPorEstoque(a, o),
        `qtd=${String(q)} atual=${a} outra=${o} deveria cair na regra por saldo`,
      );
    }
  }
});

Deno.test("call-site — analyze-unified-order escolhe a conta passando a quantidade pedida", async () => {
  const fonte = await Deno.readTextFile(new URL("../analyze-unified-order/index.ts", import.meta.url));
  assertEquals(
    fonte.includes("escolherContaPorQuantidade(prod.estoque, equivalent.estoque, vp.quantity)"),
    true,
    "analyze-unified-order não passa vp.quantity para a escolha de conta",
  );
});

// ── Call-sites: as edges leitoras não podem voltar a fabricar 0 de `estoque` ──
const LEITORES = ["../recommend/index.ts", "../analyze-unified-order/index.ts"];
// `?? 0` / `|| 0` e as coerções que fazem o mesmo em silêncio (`Number(null) === 0`, Codex P2).
const FABRICA_ZERO = /\bestoque\s*(\?\?|\|\|)\s*0\b|\b(Number|parseFloat|parseInt)\(\s*[\w.?]*estoque\b/;

Deno.test("call-sites — recommend e analyze-unified-order não convertem estoque null em 0", async () => {
  for (const rel of LEITORES) {
    const fonte = await Deno.readTextFile(new URL(rel, import.meta.url));
    const linha = fonte.split("\n").find((l) => FABRICA_ZERO.test(l));
    assertEquals(linha ?? null, null, `${rel} ainda fabrica 0 a partir de estoque: ${linha}`);
    assertEquals(fonte.includes('from "../_shared/estoque-desconhecido.ts"'), true, `${rel} não usa o helper`);
  }
});

Deno.test("call-site — a resposta da recommend leva o estoque pelo helper (null chega null ao card)", async () => {
  const fonte = await Deno.readTextFile(new URL("../recommend/index.ts", import.meta.url));
  assertEquals(fonte.includes("estoque: lerEstoque(p.estoque),"), true, "recommend não projeta estoque via lerEstoque");
});
