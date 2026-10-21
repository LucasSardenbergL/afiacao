// Testa o CÓDIGO REAL de casamento.ts (regra do par intercompany + ordem da escrita).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/fin-ic-reconcile/
import {
  casar,
  chaveContraparte,
  type LinhaMatch,
  normalizarNf,
  publicarMatches,
  type Titulo,
} from "./casamento.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// Cadastros (códigos fictícios): no Omie da colacor, 10 = oben; no da oben, 20 = colacor e 21 = a
// própria oben (auto-cadastro); no da colacor_sc, 30 = oben.
const CONTRAPARTE = new Map<string, string>([
  [chaveContraparte("colacor", 10), "oben"],
  [chaveContraparte("oben", 20), "colacor"],
  [chaveContraparte("oben", 21), "oben"],
  [chaveContraparte("colacor_sc", 30), "oben"],
]);

let seq = 0;
function cr(p: Partial<Titulo> = {}): Titulo {
  return { id: `cr${++seq}`, company: "colacor", codigo: 10, valor: 9180, data_emissao: "2024-11-19", nf: "00023572", status: "RECEBIDO", ...p };
}
function cp(p: Partial<Titulo> = {}): Titulo {
  return { id: `cp${++seq}`, company: "oben", codigo: 20, valor: 9180, data_emissao: "2024-11-19", nf: "000023572", status: "PAGO", ...p };
}
function rodar(crs: Titulo[], cps: Titulo[], travados: string[] = []): LinhaMatch[] {
  return casar({ crs, cps, contraparte: CONTRAPARTE, travados: new Set(travados) });
}
const auto = (l: LinhaMatch[]) => l.filter((x) => x.status === "auto_matched").map((x) => [x.cr_id, x.cp_id]);
const status = (l: LinhaMatch[]) => l.map((x) => x.status).sort();

Deno.test("normalizarNf — zeros à esquerda não contam; blocos não se fundem; vazio é ausente", () => {
  assertEquals(normalizarNf("00023572"), "23572");
  assertEquals(normalizarNf("000023572/1"), "23572/1");
  assertEquals(normalizarNf("235721") === normalizarNf("23572/1"), false);
  assertEquals(normalizarNf(""), null);
  assertEquals(normalizarNf("000"), null);
  assertEquals(normalizarNf(null), null);
});

Deno.test("par real da prod (NF 23572 colacor→oben) sai auto_matched com a direção certa", () => {
  const r = cr(), p = cp();
  const l = rodar([r], [p]);
  assertEquals(auto(l), [[r.id, p.id]]);
  assertEquals([l[0].empresa_origem, l[0].empresa_destino, l[0].diff_dias], ["colacor", "oben", 0]);
});

Deno.test("sem NF (nos dois lados ou num só) → NUNCA auto: valor+data não provam a operação", () => {
  assertEquals(auto(rodar([cr({ nf: null })], [cp({ nf: "" })])), []);
  const r = cr(), p = cp({ nf: null });
  const l = rodar([r], [p]);
  assertEquals(auto(l), []);
  // Fica como candidato a conferir à mão (com o CP ligado), não como divergência de valor.
  assertEquals(l.map((x) => [x.status, x.cr_id, x.cp_id]), [["sem_contrapartida", r.id, p.id]]);
});

Deno.test("NF que só coincide se fundir os blocos (23572/1 × 235721) → não casa", () => {
  assertEquals(auto(rodar([cr({ nf: "23572/1" })], [cp({ nf: "235721" })])), []);
});

Deno.test("NF dos dois lados e DIFERENTE → não casa (nem informativo)", () => {
  const l = rodar([cr({ nf: "23572" })], [cp({ nf: "23577" })]);
  assertEquals(status(l), ["sem_contrapartida", "sem_contrapartida"]);
});

Deno.test("1 centavo de diferença → não é auto_matched (a RPC exige valor igual)", () => {
  const l = rodar([cr({ valor: 9180 })], [cp({ valor: 9180.01 })]);
  assertEquals(auto(l), []);
  assertEquals(status(l), ["divergencia_valor"]);
  // 10,00 × 10,01: |Δ| em double é 0,00999… — uma tolerância "≤ 0,01" casaria aqui.
  assertEquals(auto(rodar([cr({ valor: 10 })], [cp({ valor: 10.01 })])), []);
});

Deno.test("6 dias de distância → divergencia_data, nunca auto", () => {
  const l = rodar([cr({ data_emissao: "2024-11-19" })], [cp({ data_emissao: "2024-11-25" })]);
  assertEquals(status(l), ["divergencia_data"]);
});

Deno.test("5 dias ainda casa (fronteira da tolerância)", () => {
  assertEquals(auto(rodar([cr({ data_emissao: "2024-11-19" })], [cp({ data_emissao: "2024-11-24" })])).length, 1);
});

Deno.test("unicidade MÚTUA: 2 CR para 1 CP → nenhum par, os dois duplicidade_possivel", () => {
  const l = rodar([cr(), cr()], [cp()]);
  assertEquals(auto(l), []);
  assertEquals(status(l), ["duplicidade_possivel", "duplicidade_possivel"]);
});

Deno.test("unicidade MÚTUA: 1 CR para 2 CP → nenhum par; os CPs não viram sem_contrapartida", () => {
  const l = rodar([cr()], [cp(), cp()]);
  assertEquals(auto(l), []);
  assertEquals(status(l), ["duplicidade_possivel"]);
});

Deno.test("parcelas iguais com a MESMA NF não são escolhidas a esmo", () => {
  const l = rodar([cr(), cr()], [cp(), cp()]);
  assertEquals(auto(l), []);
});

Deno.test("título num auto_matched JÁ gravado (travado) não é recasado nem vira informativo", () => {
  const r = cr(), p = cp();
  assertEquals(rodar([r], [p], [r.id, p.id]), []);
});

Deno.test("direção trocada: CP da oben cuja contraparte NÃO é a empresa do CR → não casa", () => {
  // CR colacor_sc→oben, CP na oben com fornecedor colacor (20): o par seria colacor_sc×colacor.
  const l = rodar([cr({ company: "colacor_sc", codigo: 30 })], [cp({ codigo: 20 })]);
  assertEquals(auto(l), []);
  assertEquals(l.map((x) => `${x.empresa_origem}>${x.empresa_destino}`).sort(), ["colacor>oben", "colacor_sc>oben"]);
});

Deno.test("cancelado e sem status: fora do pool (nem par, nem sem_contrapartida)", () => {
  assertEquals(rodar([cr({ status: "CANCELADO" })], [cp({ status: null })]), []);
  assertEquals(status(rodar([cr({ status: "CANCELADO" })], [cp()])), ["sem_contrapartida"]);
});

Deno.test("auto-cadastro e código desconhecido não são intercompany", () => {
  assertEquals(rodar([], [cp({ codigo: 21 })]), []);
  assertEquals(rodar([cr({ codigo: 999 })], []), []);
  assertEquals(rodar([cr({ codigo: null })], []), []);
});

Deno.test("título travado por linha do humano sai do pool inteiro", () => {
  const r = cr(), p = cp();
  assertEquals(rodar([r], [p], [p.id]).map((x) => [x.status, x.cr_id]), [["sem_contrapartida", r.id]]);
  assertEquals(rodar([r], [p], [r.id, p.id]), []);
});

Deno.test("cada título aparece em UMA linha só (a RPC dá NULL se aparecer em duas)", () => {
  const crs = [cr(), cr({ nf: "1", valor: 10 }), cr({ nf: null, valor: 50 }), cr({ nf: null, valor: 50 })];
  const cps = [cp(), cp({ nf: "1", valor: 10.2 }), cp({ nf: null, valor: 50 }), cp({ nf: "9", valor: 77 })];
  const l = rodar(crs, cps);
  const ids = l.flatMap((x) => [x.cr_id, x.cp_id]).filter(Boolean);
  assertEquals(ids.length, new Set(ids).size, "título repetido");
});

// ── publicarMatches: auto_matched nunca é apagado; informativos saem ANTES do insert (UNIQUE) ───
function escritorFake(falhaEm?: "inserir" | "apagar") {
  const log: string[] = [];
  return {
    log,
    db: {
      inserir: (l: LinhaMatch[]) => {
        log.push(`inserir:${l.length}`);
        return Promise.resolve({ error: falhaEm === "inserir" ? { message: "x" } : null });
      },
      apagarInformativos: (ids: string[]) => {
        log.push(`apagar:${ids.length}`);
        return Promise.resolve({ error: falhaEm === "apagar" ? { message: "y" } : null });
      },
    },
  };
}
const NOVA: LinhaMatch = { empresa_origem: "colacor", empresa_destino: "oben", cr_id: "a", status: "sem_contrapartida" };

Deno.test("publicarMatches — apaga os informativos ANTES de inserir (o UNIQUE de cr_id/cp_id exige)", async () => {
  const f = escritorFake();
  const d = await publicarMatches(f.db, [NOVA], ["v1", "v2"]);
  assertEquals(f.log, ["apagar:2", "inserir:1"]);
  assertEquals(d, { ok: true, inseridas: 1, informativas_apagadas: 2 });
});

Deno.test("publicarMatches — delete falhou → nada inserido, falha reportada", async () => {
  const f = escritorFake("apagar");
  assertEquals(await publicarMatches(f.db, [NOVA], ["v1"]), { ok: false, etapa: "apagar", erro: "y" });
  assertEquals(f.log, ["apagar:1"]);
});

Deno.test("publicarMatches — insert falhou é reportado (não vira sucesso)", async () => {
  const f = escritorFake("inserir");
  assertEquals(await publicarMatches(f.db, [NOVA], ["v1"]), { ok: false, etapa: "inserir", erro: "x" });
});

Deno.test("publicarMatches — apaga em lotes de 200 ids", async () => {
  const f = escritorFake();
  await publicarMatches(f.db, [], Array.from({ length: 450 }, (_, i) => `v${i}`));
  assertEquals(f.log, ["apagar:200", "apagar:200", "apagar:50"]);
});
