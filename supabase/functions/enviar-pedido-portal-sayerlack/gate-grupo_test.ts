// Gate de grupo (Prz Ent) MATERIALIZADO — o código que o Browserless recebe, não o texto do .ts.
// Por quê (Codex no diff do regrupo v1.16, 2026-11-18): o BROWSERLESS_FUNCTION é um template literal; `\s`/`\d`
// escritos com UMA barra viram `s`/`d` ao materializar (`/^\s*\d+\s*$/` → `/^s*d+s*$/`) e o regrupo do #4505
// morreria em silêncio (`prz_ent_exato=false` para "5"). O teste PG da RPC monta a prova à mão; este prova que a
// edge PRODUZ essa prova. Executa o bloco real do gate com a grade do #4505.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/enviar-pedido-portal-sayerlack/
// `assert`/`assertEquals` locais: `test:edges` roda com `--no-remote` (o flag não se afrouxa).
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(atual: unknown, esperado: unknown): void {
  const a = JSON.stringify(atual), e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}

const fonte = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const ini = fonte.indexOf("const BROWSERLESS_FUNCTION = `");
assert(ini >= 0, "BROWSERLESS_FUNCTION não encontrado");
const corpoIni = ini + "const BROWSERLESS_FUNCTION = `".length;
const corpoFim = fonte.indexOf("\n`;", corpoIni);
assert(corpoFim > corpoIni, "fim do template não encontrado");
const cru = fonte.slice(corpoIni, corpoFim);
// As interpolações são `${helper.toString()}` (o gate não usa nenhum): viram `null`; o resto materializa EXATAMENTE
// como no runtime — avaliando o template literal, que é onde `\s` vira `s`.
const semInterpolacao = cru.replace(/\$\{[^}]*\}/g, "null");
assert(!semInterpolacao.includes("${"), "interpolação não neutralizada");
const materializado: string = new Function("return `" + semInterpolacao + "`;")();

const a = materializado.indexOf("var mismatches = [];");
const b = materializado.indexOf("// validados < total", a);
assert(a >= 0 && b > a, "bloco do gate de grupo não encontrado no código materializado");
const bloco = materializado.slice(a, b);

type Linha = { sku_portal: string; prz_ent_raw: string };
type Mismatch = {
  sku_portal: string; sku_identificado: boolean; prz_ent: number; prz_ent_raw: string; prz_ent_exato: boolean;
  lt_esperado: number;
};
type GrupoLeadtime = {
  header_prz: string; linhas_total: number; linhas_validadas: number; linhas_exatas: number; enviados: string[];
  mismatches: Mismatch[];
};
type Resultado = { data: { erroTipo: string; grupoLeadtime: GrupoLeadtime } } | null;
const rodarGate = (linhas: Linha[], lt = 8): Resultado => {
  const fn = new Function("ltEsperado", "scrape", "linhasPortal", "trace", "skusConhecidos",
    bloco + "\nreturn null;");
  const scrape = { ok: true, przIdx: 6, headers: ["UN", "Cap Emb", "Qtd Fat", "Qtd UN", "Preço Fat", "Preço UN", "Prz Ent"] };
  return fn(lt, scrape, linhas, [], linhas.map((l) => l.sku_portal.toUpperCase()));
};

Deno.test("#4505 materializado: célula '5' é inteiro exato e a prova sai completa", () => {
  const r = rodarGate([
    { sku_portal: "YC.1400FP", prz_ent_raw: "5" },
    { sku_portal: "YO20.1464.00BB", prz_ent_raw: "8" },
    { sku_portal: "FCA.6888QT", prz_ent_raw: " 8 " },
  ]);
  assert(r !== null, "gate não recusou");
  assertEquals(r.data.erroTipo, "GRUPO_LEADTIME_MISMATCH");
  const g = r.data.grupoLeadtime;
  assertEquals(g.header_prz, "Prz Ent");
  assertEquals([g.linhas_total, g.linhas_validadas, g.linhas_exatas], [3, 3, 3]);
  assertEquals(g.enviados, ["YC.1400FP", "YO20.1464.00BB", "FCA.6888QT"]);
  assertEquals(g.mismatches.length, 1);
  const m = g.mismatches[0];
  assertEquals([m.sku_portal, m.sku_identificado, m.prz_ent, m.prz_ent_raw, m.prz_ent_exato, m.lt_esperado],
    ["YC.1400FP", true, 5, "5", true, 8]);
});

Deno.test("materializado: '5-8' não é exato e uma '8-12' que o gate leu como 8 derruba linhas_exatas", () => {
  const r = rodarGate([
    { sku_portal: "A", prz_ent_raw: "5-8" },
    { sku_portal: "B", prz_ent_raw: "8-12" },
  ]);
  assert(r !== null, "gate não recusou");
  const g = r.data.grupoLeadtime;
  assertEquals(g.mismatches.map((x) => x.prz_ent_exato), [false]);
  assertEquals([g.linhas_total, g.linhas_validadas, g.linhas_exatas], [2, 2, 0]);
});

Deno.test("materializado: controle — grade toda no LT não recusa", () => {
  assertEquals(rodarGate([{ sku_portal: "A", prz_ent_raw: "8" }]), null);
});
