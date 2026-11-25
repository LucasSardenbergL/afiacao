// Testa o CÓDIGO REAL de reenvio-os-local.ts (PR 2.5) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/omie-sync/reenvio-os-local_test.ts
import { avisoEnderecoTurnoOs } from "./reenvio-os-local.ts";

function igual(veio: unknown, esperado: unknown, ctx: string) {
  const v = JSON.stringify(veio);
  const e = JSON.stringify(esperado);
  if (v !== e) throw new Error(`${ctx}: esperava ${e}, veio ${v}`);
}
function marca(v: string | null, m: string, ctx: string) {
  if (!v || !v.includes(m)) throw new Error(`${ctx}: esperava a marca [${m}], veio ${JSON.stringify(v)}`);
}

const END_A = { street: "Rua A", number: "10", city: "Joinville" };
const END_B = { street: "Rua B", number: "20", city: "Joinville" };
const MOD = "coleta_entrega";
const linha = (over: Record<string, unknown> = {}) => ({ address: END_A, time_slot: "manha", delivery_option: MOD, ...over });

Deno.test("sem linha ou nada mudou = sem aviso (inclusive chaves em outra ordem)", () => {
  igual(avisoEnderecoTurnoOs(null, { address: END_A, time_slot: "manha" }, MOD, "OS1"), null, "sem linha");
  igual(
    avisoEnderecoTurnoOs(linha({ address: { city: "Joinville", number: "10", street: "Rua A" } }), { address: END_A, time_slot: "manha" }, MOD, "OS1"),
    null,
    "ordem de chaves",
  );
  igual(avisoEnderecoTurnoOs(linha({ address: null, time_slot: null, delivery_option: "balcao" }), { address: null, time_slot: null }, "balcao", "OS1"), null, "balcão");
});

Deno.test("modalidade não declarada ou diferente da gravada = sem aviso (nada a comparar)", () => {
  igual(avisoEnderecoTurnoOs(linha(), { address: null, time_slot: null }, null, "OS2"), null, "front antigo");
  igual(avisoEnderecoTurnoOs(linha(), { address: END_B, time_slot: "manha" }, "somente_entrega", "OS3"), null, "outra modalidade");
});

Deno.test("endereço, turno ou os dois diferentes = aviso de que o gravado foi MANTIDO", () => {
  const e = avisoEnderecoTurnoOs(linha(), { address: END_B, time_slot: "manha" }, MOD, "OS77");
  marca(e, "OS77", "nº da OS");
  marca(e, "o endereço deste envio NÃO entrou", "endereço");
  marca(e, "manteve o da tentativa anterior", "mantido");
  marca(avisoEnderecoTurnoOs(linha(), { address: END_A, time_slot: "tarde" }, MOD, "OS78"), "o turno deste envio NÃO entrou", "turno");
  marca(avisoEnderecoTurnoOs(linha({ time_slot: null }), { address: END_B, time_slot: "tarde" }, MOD, "OS79"), "o endereço e o turno", "ambos");
  marca(avisoEnderecoTurnoOs(linha(), { address: null, time_slot: "manha" }, MOD, "OS80"), "o endereço deste envio NÃO entrou", "envio sem endereço");
});
