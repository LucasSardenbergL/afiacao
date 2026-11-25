// Testa o CÓDIGO REAL de reenvio-os-local.ts (PR 2.5) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/omie-sync/reenvio-os-local_test.ts
import { decidirAtualizacaoLocalOs, STATUS_ATUALIZAVEL } from "./reenvio-os-local.ts";

function igual(veio: unknown, esperado: unknown, ctx: string) {
  const v = JSON.stringify(veio);
  const e = JSON.stringify(esperado);
  if (v !== e) throw new Error(`${ctx}: esperava ${e}, veio ${v}`);
}
function marca(v: string | undefined, m: string, ctx: string) {
  if (!v || !v.includes(m)) throw new Error(`${ctx}: esperava a marca [${m}], veio ${JSON.stringify(v)}`);
}

const END_A = { street: "Rua A", number: "10", city: "Joinville" };
const END_B = { street: "Rua B", number: "20", city: "Joinville" };
const MOD = "coleta_entrega";
const linha = (over: Record<string, unknown> = {}) => ({
  address: END_A, time_slot: "manha", status: STATUS_ATUALIZAVEL, delivery_option: MOD, ...over,
});

Deno.test("sem linha ou nada mudou = nada (inclusive chaves em outra ordem)", () => {
  igual(decidirAtualizacaoLocalOs(null, { address: END_A, time_slot: "manha" }, MOD, "OS1"), { acao: "nada" }, "sem linha");
  igual(
    decidirAtualizacaoLocalOs(linha({ address: { city: "Joinville", number: "10", street: "Rua A" } }), { address: END_A, time_slot: "manha" }, MOD, "OS1"),
    { acao: "nada" },
    "ordem de chaves",
  );
  igual(
    decidirAtualizacaoLocalOs(linha({ address: null, time_slot: null, delivery_option: "balcao" }), { address: null, time_slot: null }, "balcao", "OS1"),
    { acao: "nada" },
    "balcão",
  );
});

Deno.test("front antigo (sem modalidade) NUNCA apaga endereço/turno válidos", () => {
  igual(decidirAtualizacaoLocalOs(linha(), { address: null, time_slot: null }, null, "OS2"), { acao: "nada" }, "modalidade não declarada");
});

Deno.test("modalidade deste envio diferente da gravada = nada (não regrava por baixo)", () => {
  igual(decidirAtualizacaoLocalOs(linha(), { address: END_B, time_slot: "manha" }, "somente_entrega", "OS3"), { acao: "nada" }, "outra modalidade");
});

Deno.test("endereço trocado em pedido_recebido = atualiza SÓ o endereço, com aviso", () => {
  const d = decidirAtualizacaoLocalOs(linha(), { address: END_B, time_slot: "manha" }, MOD, "OS77");
  if (d.acao !== "atualizar") throw new Error(`esperava atualizar, veio ${d.acao}`);
  igual(d.campos, { address: END_B }, "só o campo que mudou");
  marca(d.aviso, "OS77", "nº da OS");
  marca(d.aviso, "o endereço deste envio foi atualizado no app", "o quê");
  if (d.aviso.includes("observação")) throw new Error("turno igual não deve falar da observação");
});

Deno.test("turno trocado atualiza SÓ o turno e avisa da observação no Omie", () => {
  const d = decidirAtualizacaoLocalOs(linha(), { address: END_A, time_slot: "tarde" }, MOD, "OS78");
  if (d.acao !== "atualizar") throw new Error(`esperava atualizar, veio ${d.acao}`);
  igual(d.campos, { time_slot: "tarde" }, "só o turno (não regrava o endereço de um reenvio concorrente)");
  marca(d.aviso, "o turno deste envio", "o quê");
  marca(d.aviso, "observação dela segue o da tentativa anterior", "obs");
  const ambos = decidirAtualizacaoLocalOs(linha({ time_slot: null }), { address: END_B, time_slot: "tarde" }, MOD, "OS79");
  if (ambos.acao !== "atualizar") throw new Error("ambos: esperava atualizar");
  igual(ambos.campos, { address: END_B, time_slot: "tarde" }, "os dois mudaram");
  marca(ambos.aviso, "o endereço e o turno", "ambos");
});

Deno.test("fora de pedido_recebido NÃO regrava — recusa com aviso", () => {
  for (const status of ["aguardando_coleta", "em_rota", null]) {
    const d = decidirAtualizacaoLocalOs(linha({ status }), { address: END_B, time_slot: "manha" }, MOD, "OS80");
    if (d.acao !== "recusar") throw new Error(`${status}: esperava recusar, veio ${d.acao}`);
    marca(d.aviso, "NÃO foi gravado no app", String(status));
  }
});
