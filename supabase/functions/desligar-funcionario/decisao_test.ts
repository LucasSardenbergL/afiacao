// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/desligar-funcionario/
import { httpDoErroRpc, lerPedido, lerRespostaRpc } from "./decisao.ts";

// `assertEquals` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}

const U = "00000000-0000-0000-0000-0000000000f1";
const N = "00000000-0000-0000-0000-0000000000b1";

Deno.test("pedido: válido com novo dono", () => {
  assertEquals(lerPedido({ user_id: U, novo_dono_user_id: N, motivo: "  saiu  " }), { userId: U, novoDono: N, motivo: "saiu" });
});

Deno.test("pedido: novo dono ausente/vazio vira null", () => {
  assertEquals(lerPedido({ user_id: U, motivo: "saiu" }), { userId: U, novoDono: null, motivo: "saiu" });
  assertEquals(lerPedido({ user_id: U, novo_dono_user_id: "", motivo: "saiu" }), { userId: U, novoDono: null, motivo: "saiu" });
});

Deno.test("pedido: recusas", () => {
  assertEquals("erro" in lerPedido({ user_id: "x", motivo: "saiu" }), true);
  assertEquals("erro" in lerPedido({ user_id: U, novo_dono_user_id: 42, motivo: "saiu" }), true);
  assertEquals("erro" in lerPedido({ user_id: U, motivo: "ab" }), true);
  assertEquals("erro" in lerPedido({ user_id: U, motivo: "x".repeat(501) }), true);
});

Deno.test("erro da RPC → HTTP; desconhecido é 500", () => {
  assertEquals(
    ["42501", "22023", "22004", "55P03", "55000", "P0001", undefined].map(httpDoErroRpc),
    [403, 400, 400, 409, 409, 500, 500],
  );
});

Deno.test("resposta da RPC: só formas conhecidas", () => {
  assertEquals(lerRespostaRpc({ status: "desligado", desligamento_id: U }), { status: "desligado", desligamento_id: U });
  assertEquals(lerRespostaRpc({ status: "ja_desligado", desligamento_id: null }), { status: "ja_desligado", desligamento_id: null });
  assertEquals(lerRespostaRpc({ status: "desligado", desligamento_id: null }), null);
  assertEquals(lerRespostaRpc({ status: "ok" }), null);
  assertEquals(lerRespostaRpc(null), null);
  assertEquals(lerRespostaRpc([]), null);
});
