// Testa a conversão PURA Omie→portal (qtdePortal). Rodar: deno test supabase/functions/enviar-pedido-portal-sayerlack/
import { FatorConversaoInvalidoError, qtdePortal } from "./qtde-portal.ts";

// Asserts LOCAIS de propósito (sem jsr:@std/assert): `deno test --no-remote` roda no `validate` do CI.
function assertEquals(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: esperado ${String(expected)}, veio ${String(actual)}`);
}
function assertLancaFator(fn: () => unknown, msg: string) {
  try {
    fn();
  } catch (e) {
    if (e instanceof FatorConversaoInvalidoError) return; // casa a MARCA do ramo, não "lançou algo"
    throw new Error(`${msg}: lançou outra coisa (${String(e)})`);
  }
  throw new Error(`${msg}: não lançou`);
}

Deno.test("fator 1 = identidade (concentrados QT/GL já vêm em embalagens)", () => {
  assertEquals(qtdePortal(4, 1), 4, "4 QT");
  assertEquals(qtdePortal(2, 1), 2, "2 GL");
  assertEquals(qtdePortal(3.99996, 1), 4, "poeira decimal do Omie sobe para 4");
});

Deno.test("fator 0,2 = litro → balde de 5 L, sempre para cima", () => {
  const casos: Array<[number, number]> = [[5, 1], [10, 2], [35, 7], [36, 8], [40, 8], [45, 9], [55, 11], [70, 14], [1, 1]];
  for (const [litros, baldes] of casos) assertEquals(qtdePortal(litros, 0.2), baldes, `${litros} L`);
});

Deno.test("múltiplo exato NÃO ganha embalagem extra por poeira binária", () => {
  // 0,2 não é exato em IEEE-754: sem round6, algum q*0.2 pode dar 7,000000000000001 → ceil 8.
  for (let litros = 5; litros <= 500; litros += 5) {
    assertEquals(qtdePortal(litros, 0.2), litros / 5, `${litros} L exato`);
  }
  assertEquals(qtdePortal(3.24, 1 / 3.24), 1, "1 galão-base (3,24 L)");
  assertEquals(qtdePortal(4.05, 1 / 0.81), 5, "5 quartinhos-base (0,81 L)");
  // Casos VIVOS onde o float morde (medido em node, literais de 2 casas): 10,8 × (1/3,6) = 3,0000000000000004
  // → ceil 4 sem round6 (galão 3,6 L e quartinho 0,9 L mordem; 5 / 3,24 / 0,81 não mordem em 0..2000 L).
  // Os asserts acima são regressão; ESTES são a prova de que o round6 faz trabalho (sabotá-lo = vermelho).
  assertEquals(qtdePortal(10.8, 1 / 3.6), 3, "3 galões (10,8 L)");
  assertEquals(qtdePortal(21.6, 1 / 3.6), 6, "6 galões (21,6 L)");
  assertEquals(qtdePortal(2.7, 1 / 0.9), 3, "3 quartinhos (2,7 L)");
  assertEquals(qtdePortal(5.4, 1 / 0.9), 6, "6 quartinhos (5,4 L)");
});

Deno.test("mínimo 1 unidade no portal", () => {
  assertEquals(qtdePortal(0.5, 1), 1, "0,5");
  assertEquals(qtdePortal(0, 1), 1, "0 (o guard nQtde>0 do chamador barra antes)");
});

Deno.test("fail-closed: fator inválido lança a marca do ramo (nunca 'NaN' no input do portal)", () => {
  assertLancaFator(() => qtdePortal(36, 0), "fator 0");
  assertLancaFator(() => qtdePortal(36, -0.2), "fator negativo");
  assertLancaFator(() => qtdePortal(36, Number.NaN), "fator NaN");
  assertLancaFator(() => qtdePortal(36, Number.POSITIVE_INFINITY), "fator Infinity");
  assertLancaFator(() => qtdePortal(Number.NaN, 0.2), "qtde NaN");
});
