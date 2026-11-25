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

Deno.test("sem linha ou nada mudou = nada (inclusive chaves em outra ordem)", () => {
  igual(decidirAtualizacaoLocalOs(null, { address: END_A, time_slot: "manha" }, "OS1"), { acao: "nada" }, "sem linha");
  igual(
    decidirAtualizacaoLocalOs({ address: { city: "Joinville", number: "10", street: "Rua A" }, time_slot: "manha", status: STATUS_ATUALIZAVEL }, { address: END_A, time_slot: "manha" }, "OS1"),
    { acao: "nada" },
    "ordem de chaves",
  );
  igual(decidirAtualizacaoLocalOs({ address: null, time_slot: null, status: "em_rota" }, { address: null, time_slot: null }, "OS1"), { acao: "nada" }, "balcão");
});

Deno.test("endereço trocado em pedido_recebido = atualiza com aviso", () => {
  const d = decidirAtualizacaoLocalOs({ address: END_A, time_slot: "manha", status: STATUS_ATUALIZAVEL }, { address: END_B, time_slot: "manha" }, "OS77");
  if (d.acao !== "atualizar") throw new Error(`esperava atualizar, veio ${d.acao}`);
  igual(d.campos, { address: END_B, time_slot: "manha" }, "campos");
  marca(d.aviso, "OS77", "nº da OS");
  marca(d.aviso, "o endereço deste envio foi atualizado no app", "o quê");
  if (d.aviso.includes("observação")) throw new Error("turno igual não deve falar da observação");
});

Deno.test("turno trocado avisa que a observação no Omie segue a antiga", () => {
  const d = decidirAtualizacaoLocalOs({ address: END_A, time_slot: "manha", status: STATUS_ATUALIZAVEL }, { address: END_A, time_slot: "tarde" }, "OS78");
  if (d.acao !== "atualizar") throw new Error(`esperava atualizar, veio ${d.acao}`);
  marca(d.aviso, "o turno deste envio", "o quê");
  marca(d.aviso, "observação dela segue o da tentativa anterior", "obs");
  const ambos = decidirAtualizacaoLocalOs({ address: END_A, time_slot: null, status: STATUS_ATUALIZAVEL }, { address: END_B, time_slot: "tarde" }, "OS79");
  if (ambos.acao !== "atualizar") throw new Error("ambos: esperava atualizar");
  marca(ambos.aviso, "o endereço e o turno", "ambos");
});

Deno.test("fora de pedido_recebido NÃO regrava — recusa com aviso", () => {
  for (const status of ["aguardando_coleta", "em_rota", null]) {
    const d = decidirAtualizacaoLocalOs({ address: END_A, time_slot: "manha", status }, { address: END_B, time_slot: "manha" }, "OS80");
    if (d.acao !== "recusar") throw new Error(`${status}: esperava recusar, veio ${d.acao}`);
    marca(d.aviso, "NÃO foi gravado no app", String(status));
  }
});
