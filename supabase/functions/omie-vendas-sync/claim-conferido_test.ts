// Testa o CÓDIGO REAL de claim-conferido.ts no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-vendas-sync/claim-conferido_test.ts
function assertEquals(v: unknown, e: unknown): void {
  const a = JSON.stringify(v), b = JSON.stringify(e);
  if (a !== b) throw new Error(`esperava ${b}, veio ${a}`);
}
import { MARCA_PEDIDO_ALTERADO, mensagemPedidoAlterado, mesmosItensDeEnvio, projecaoItensEnvio } from "./claim-conferido.ts";

const A = { omie_codigo_produto: 1, quantidade: 2, valor_unitario: 10 };
const B = { omie_codigo_produto: 2, quantidade: 1, valor_unitario: 7.5 };

Deno.test("mesmos itens, mesma ordem → iguais", () => {
  assertEquals(mesmosItensDeEnvio([A, B], [A, B]), true);
});

Deno.test("mesma lista noutra ordem → iguais (retry que relê sem ORDER BY)", () => {
  assertEquals(mesmosItensDeEnvio([A, B], [B, A]), true);
});

Deno.test("número como string e campo cosmético a mais → iguais", () => {
  assertEquals(
    mesmosItensDeEnvio([A], [{ omie_codigo_produto: "1", quantidade: "2", valor_unitario: "10.00", descricao: "x" }]),
    true,
  );
});

Deno.test("quantidade, preço ou código diferentes → divergentes", () => {
  assertEquals(mesmosItensDeEnvio([A], [{ ...A, quantidade: 3 }]), false);
  assertEquals(mesmosItensDeEnvio([A], [{ ...A, valor_unitario: 11 }]), false);
  assertEquals(mesmosItensDeEnvio([A], [{ ...A, omie_codigo_produto: 9 }]), false);
});

Deno.test("cor da tinta trocada com base, qtd e preço iguais → divergentes", () => {
  assertEquals(mesmosItensDeEnvio([{ ...A, tint_cor_id: "branco" }], [{ ...A, tint_cor_id: "azul" }]), false);
  assertEquals(mesmosItensDeEnvio([{ ...A, tint_cor_id: "branco" }], [A]), false);
});

Deno.test("item a mais, lista vazia, não-lista ou item sem valor → divergentes", () => {
  assertEquals(mesmosItensDeEnvio([A, B], [A]), false);
  assertEquals(mesmosItensDeEnvio([], []), false);
  assertEquals(mesmosItensDeEnvio(null, [A]), false);
  assertEquals(mesmosItensDeEnvio([{ omie_codigo_produto: 1, quantidade: 2 }], [{ omie_codigo_produto: 1, quantidade: 2 }]), false);
  assertEquals(mesmosItensDeEnvio([{ ...A, valor_unitario: "10,50" }], [{ ...A, valor_unitario: "10,50" }]), false);
});

Deno.test("projeção ordena pelo conteúdo", () => {
  assertEquals(projecaoItensEnvio([B, A]), [[1, 2, 10, null], [2, 1, 7.5, null]]);
});

Deno.test("mensagem carrega a marca estável que a tela procura", () => {
  const m = mensagemPedidoAlterado("so-1");
  assertEquals(m.includes(MARCA_PEDIDO_ALTERADO), true);
  assertEquals(m.includes("O Omie NÃO foi atualizado"), true);
});
