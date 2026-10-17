// Testa o CÓDIGO REAL de etapa-desconhecida.ts (PR(d) da baixa de PO) no runtime Deno.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync-estoque/etapa-desconhecida_test.ts
//
// O caso que motiva: a associação nativa NF↔PO no Omie leva o PO para "Recebido Parcialmente", cujo cEtapa ninguém
// mediu. Sem esta guarda o saldo ainda não recebido sumiria do "a caminho" e o motor recompraria. Falsificações:
//   (a) etapa desconhecida COM saldo recusa;            (b) etapa conhecida (10, 15) nunca recusa aqui;
//   (c) etapa desconhecida totalmente recebida passa;   (d) AUSÊNCIA não prova saldo zero: sem itens / [] / ilegível recusa;
//   (e) etapa vazia é desconhecida;                     (f) nQtdeRec omitido (Omie) = nada recebido → saldo cheio → recusa.
import { problemaDeEtapaDesconhecida } from "./etapa-desconhecida.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg ? `${msg}: ` : ""}esperado ${jb}, veio ${ja}`);
}
function assertContem(s: string | null, trecho: string, msg: string) {
  if (s === null || !s.includes(trecho)) throw new Error(`${msg}: esperado conter ${JSON.stringify(trecho)}, veio ${JSON.stringify(s)}`);
}

// Mesmo contrato de parse da edge: estrito, e nQtdeRec ausente = 0 (o Omie omite).
function parseQtd(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v !== "string") return NaN;
  const s = v.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}
const parse = { parseQtd, parseRecebido: (v: unknown) => (v === undefined ? 0 : parseQtd(v)) };
const CONHECIDAS = new Set(["15", "10"]);
const avaliar = (etapa: string, itens: unknown) => problemaDeEtapaDesconhecida(etapa, itens, CONHECIDAS, "1244", parse);

Deno.test("(a) etapa desconhecida com saldo a receber recusa, citando PO e etapa", () => {
  const p = avaliar("40", [{ nQtde: 10, nQtdeRec: 4 }]);
  assertContem(p, 'PO 1244 com etapa DESCONHECIDA "40"', "mensagem identifica");
  assertContem(p, "saldo a receber", "motivo");
});

Deno.test("(b) etapas conhecidas nunca recusam por aqui — nem sem itens", () => {
  assertEquals(avaliar("15", [{ nQtde: 10 }]), null, "15");
  assertEquals(avaliar("10", undefined), null, "10 sem itens");
});

Deno.test("(c) etapa desconhecida totalmente recebida não recusa", () => {
  assertEquals(avaliar("40", [{ nQtde: 2, nQtdeRec: 2 }, { nQtde: "3", nQtdeRec: "3.0" }]), null, "saldo zero");
});

Deno.test("(d) ausência não prova saldo zero", () => {
  assertContem(avaliar("40", undefined), "sem itens legíveis", "sem lista");
  assertContem(avaliar("40", []), "sem itens legíveis", "lista vazia");
  assertContem(avaliar("40", [{ nQtde: "", nQtdeRec: 0 }]), "quantidade ilegível", "nQtde vazio");
  assertContem(avaliar("40", [{ nQtde: 5, nQtdeRec: null }]), "quantidade ilegível", "nQtdeRec null");
  assertContem(avaliar("40", [null]), "quantidade ilegível", "item nulo");
});

Deno.test("(e) etapa vazia é desconhecida", () => {
  assertContem(avaliar("", [{ nQtde: 1 }]), 'etapa DESCONHECIDA ""', "vazia");
});

Deno.test("(f) nQtdeRec omitido conta como nada recebido", () => {
  assertContem(avaliar("40", [{ nQtde: 2, nQtdeRec: 2 }, { nQtde: 1 }]), "saldo a receber", "2º item com saldo");
});
