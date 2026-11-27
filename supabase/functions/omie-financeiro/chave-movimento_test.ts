// Testa o CÓDIGO REAL de chave-movimento.ts no runtime Deno (sem import remoto: --no-remote).
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
  }
}
/** Exige que lance COM a marca do ramo (não "lançou qualquer coisa"). */
function assertLancaCom(fn: () => unknown, marca: string) {
  let msg: string | null = null;
  try {
    fn();
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  if (msg === null) throw new Error(`esperava lançar com [${marca}], não lançou`);
  if (!msg.includes(marca)) throw new Error(`lançou sem a marca [${marca}]: ${msg}`);
}
import { aplicarChaves, chaveMovimento, SensorColapso } from "./chave-movimento.ts";

Deno.test("sem nCodBaixa ⇒ hash legado", () => {
  assertEquals(chaveMovimento("123", undefined), "123");
  assertEquals(chaveMovimento("123", null), "123");
  assertEquals(chaveMovimento("123", 0), "123");
  assertEquals(chaveMovimento("123", ""), "123");
});

Deno.test("nCodBaixa válido ⇒ -nCodBaixa (espaço negativo, nunca colide com o hash >= 0)", () => {
  assertEquals(chaveMovimento("999", 12081592381), "-12081592381");
  assertEquals(chaveMovimento("999", Number.MAX_SAFE_INTEGER), `-${Number.MAX_SAFE_INTEGER}`);
});

Deno.test("duas baixas de mesmo hash e ids distintos ⇒ chaves distintas (o colapso morre)", () => {
  const a = chaveMovimento("777", 1001);
  const b = chaveMovimento("777", 1002);
  assertEquals(a === b, false);
});

Deno.test("nCodBaixa presente e inválido LANÇA (não cai no hash em silêncio)", () => {
  for (const v of [2 ** 60, 1.5, -3, "123", Number.NaN, { x: 1 }]) {
    assertLancaCom(() => chaveMovimento("1", v), "nCodBaixa presente e inválido");
  }
});

Deno.test("SensorColapso conta k-1 por hash com ids distintos", () => {
  const s = new SensorColapso();
  for (let i = 0; i < 10; i++) s.registrar("h20000", 5000 + i); // 10 baixas num hash
  s.registrar("h124", 1);
  s.registrar("h124", 2); // 2 baixas
  s.registrar("h1", 9);
  s.registrar("h1", 9); // mesma baixa relida: não é colapso
  s.registrar("h0", undefined); // sem id: ignorado
  assertEquals(s.baixasColapsadas(), 10);
  assertEquals(s.hashesComColisao(), 2);
});

Deno.test("página: 2 baixas de MESMO hash e ids distintos sobrevivem ao Map da página; replay idem", () => {
  const item = (id: number) => ({ row: { omie_ncodmov: "h20000", valor: 2000 }, hashLegado: "h20000", nCodBaixaBruto: id });
  const pagina = [item(5001), item(5002)];
  const dedup = (rows: { omie_ncodmov: string; valor: number }[]) =>
    Array.from(new Map(rows.map((r) => [r.omie_ncodmov, r])).values());
  const s = new SensorColapso();
  const gravadas = dedup(aplicarChaves(pagina, s));
  assertEquals(gravadas.length, 2, "as duas baixas chegam ao upsert");
  assertEquals(gravadas.reduce((a, r) => a + r.valor, 0), 4000, "soma correta");
  assertEquals(s.baixasColapsadas(), 1, "a chave antiga colapsaria 1");
  // replay (sync seguinte) gera as MESMAS chaves ⇒ upsert atualiza, não insere
  const replay = dedup(aplicarChaves(pagina, new SensorColapso()));
  assertEquals(replay.map((r) => r.omie_ncodmov), gravadas.map((r) => r.omie_ncodmov));
  // sem o id (chave antiga) as duas viram UMA — o defeito original
  assertEquals(dedup(pagina.map((p) => p.row)).length, 1);
});

Deno.test("aplicarChaves lança com nCodBaixa inválido (a página não grava)", () => {
  assertLancaCom(
    () => aplicarChaves([{ row: { omie_ncodmov: "h" }, hashLegado: "h", nCodBaixaBruto: 2 ** 60 }], new SensorColapso()),
    "nCodBaixa presente e inválido",
  );
});
