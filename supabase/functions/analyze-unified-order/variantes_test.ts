// Testa o CÓDIGO REAL de variantes.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/analyze-unified-order/
//
// Foco (PR 3.1): uma variante por item (o par Oben/Colacor não duplica), ambíguo fica para o
// vendedor (resgate e embalagem só escolhem com UM candidato) e nada some sem motivo.
import {
  type CandidatoCatalogo,
  colapsarMesmoCodigo,
  embalagensPedidas,
  filtrarParaResgate,
  MAX_CANDIDATOS_AMBIGUOS,
  representantesPorCodigo,
  resolverCandidatos,
  resolverEmbalagens,
  sugestoesDeAmbiguo,
} from "./variantes.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(
      `${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`,
    );
  }
}

const LT_OBEN: CandidatoCatalogo = { id: "lt-o", codigo: "DR.4403LT", descricao: "THINNER DR.4403LT", account: "oben", estoque: 2 };
const LT_COLA: CandidatoCatalogo = { id: "lt-c", codigo: "DR.4403LT", descricao: "THINNER DR.4403LT", account: "colacor", estoque: 50 };
const L5_OBEN: CandidatoCatalogo = { id: "l5-o", codigo: "DR.4403L5", descricao: "THINNER DR.4403L5", account: "oben", estoque: 9 };
const GL_OBEN: CandidatoCatalogo = { id: "gl-o", codigo: "DR.4403GL", descricao: "THINNER DR.4403GL", account: "oben", estoque: 9 };

const catalogo = new Map([LT_OBEN, LT_COLA, L5_OBEN, GL_OBEN].map((c) => [c.id, c]));

// ─────────────────────────── representantes / resolver ───────────────────────────

Deno.test("representantesPorCodigo: o par Oben/Colacor vira UM, na conta que cobre o pedido", () => {
  const reps = representantesPorCodigo([LT_OBEN, LT_COLA], 10);
  assertEquals(reps.map((r) => r.id), ["lt-c"], "10 unidades: só a Colacor (50) cobre");
  assertEquals(representantesPorCodigo([LT_OBEN, LT_COLA], 2).map((r) => r.id), ["lt-o"], "2 unidades: as duas cobrem, vence o menor saldo");
});

Deno.test("resolverCandidatos: um código distinto resolve, mesmo vindo nas duas empresas", () => {
  const r = resolverCandidatos([LT_OBEN, LT_COLA], 1);
  assertEquals(r.tipo, "unico");
});

Deno.test("resolverCandidatos: dois códigos distintos são AMBÍGUOS — nunca o primeiro da lista", () => {
  const r = resolverCandidatos([LT_OBEN, L5_OBEN], 1);
  assertEquals(r.tipo, "ambiguo");
  if (r.tipo === "ambiguo") assertEquals(r.candidatos.map((c) => c.id), ["lt-o", "l5-o"]);
});

Deno.test("resolverCandidatos: lista vazia é nenhum", () => {
  assertEquals(resolverCandidatos([], 1).tipo, "nenhum");
});

// ─────────────────────────────── filtro do resgate ───────────────────────────────

Deno.test("filtrarParaResgate: a embalagem pedida é filtro DURO — sem candidato com ela, nada é resgatado", () => {
  assertEquals(filtrarParaResgate([LT_OBEN, L5_OBEN], "DR", "BH"), []);
  assertEquals(filtrarParaResgate([LT_OBEN, L5_OBEN], "DR", "L5").map((c) => c.id), ["l5-o"]);
});

Deno.test("filtrarParaResgate: o prefixo é brando — não zera a lista quando não casa nenhum", () => {
  assertEquals(filtrarParaResgate([LT_OBEN, L5_OBEN], "FO", null).map((c) => c.id), ["lt-o", "l5-o"]);
});

// ─────────────────────────────── sugestões de ambíguo ───────────────────────────────

Deno.test("sugestoesDeAmbiguo: carrega quantidade e marca de inferida, e respeita o teto", () => {
  const muitos = Array.from({ length: 10 }, (_, i) => ({ ...LT_OBEN, id: `x${i}`, codigo: `C${i}` }));
  const s = sugestoesDeAmbiguo({ descricao: "thinner", quantity: 3, quantidade_inferida: false }, muitos, "motivo");
  assertEquals(s.length, MAX_CANDIDATOS_AMBIGUOS);
  assertEquals(s[0].quantity, 3);
  assertEquals(s[0].quantidade_inferida, false);
  assertEquals(s[0].reason, "motivo");
});

// ─────────────────────────────── colapsar mesmo código ───────────────────────────────

Deno.test("colapsarMesmoCodigo: a IA devolve Oben E Colacor do mesmo item — sai UM (o 'adicionar tudo' não duplica)", () => {
  const { unicos, sugestoes } = colapsarMesmoCodigo([
    { product_id: "lt-o", quantity: 10, quantidade_inferida: false, account: "oben" },
    { product_id: "lt-c", quantity: 10, quantidade_inferida: false, account: "colacor" },
  ], catalogo);
  assertEquals(unicos.length, 1);
  assertEquals(unicos[0].product_id, "lt-c", "a conta é a que cobre as 10, não a primeira listada");
  assertEquals(unicos[0].account, "colacor");
  assertEquals(sugestoes, []);
});

Deno.test("colapsarMesmoCodigo: a marca de inferida não se perde no colapso", () => {
  const { unicos } = colapsarMesmoCodigo([
    { product_id: "lt-o", quantity: 1, quantidade_inferida: false },
    { product_id: "lt-c", quantity: 1, quantidade_inferida: true },
  ], catalogo);
  assertEquals(unicos[0].quantidade_inferida, true);
});

Deno.test("colapsarMesmoCodigo: mesmo código com quantidades DIFERENTES vira sugestão (o vendedor decide)", () => {
  const { unicos, sugestoes } = colapsarMesmoCodigo([
    { product_id: "lt-o", quantity: 2 },
    { product_id: "lt-c", quantity: 5 },
  ], catalogo);
  assertEquals(unicos, []);
  assertEquals(sugestoes.map((s) => s.quantity), [2, 5]);
});

Deno.test("colapsarMesmoCodigo: códigos distintos e item fora do catálogo passam intactos, na ordem", () => {
  const { unicos } = colapsarMesmoCodigo([
    { product_id: "lt-o", quantity: 1 },
    { product_id: "fantasma", quantity: 1 },
    { product_id: "l5-o", quantity: 1 },
  ], catalogo);
  assertEquals(unicos.map((u) => u.product_id), ["lt-o", "fantasma", "l5-o"]);
});

// ─────────────────────────────── embalagens ───────────────────────────────

Deno.test("embalagensPedidas: lê a tabela de embalagem do prompt", () => {
  assertEquals([...embalagensPedidas("3 latas de 4403")], ["LT"]);
  assertEquals([...embalagensPedidas("4403 5L")], ["L5"]);
  assertEquals([...embalagensPedidas("um galão de 4403")], ["GL"]);
  assertEquals([...embalagensPedidas("4403")], []);
  assertEquals([...embalagensPedidas("15L de 4403")], [], "15L não é 5L");
});

Deno.test("resolverEmbalagens: sem pista no texto, duas embalagens viram SUGESTÃO — nenhuma entra sozinha", () => {
  const { mantidos, sugestoes } = resolverEmbalagens([
    { product_id: "lt-o", quantity: 1 },
    { product_id: "l5-o", quantity: 1 },
  ], catalogo, "2 thinner 4403");
  assertEquals(mantidos, []);
  assertEquals(resolverEmbalagens([{ product_id: "lt-o" }, { product_id: "l5-o" }], catalogo, "4403").ambiguos, 1);
  assertEquals(sugestoes.map((s) => s.product_id), ["lt-o", "l5-o"]);
});

Deno.test("resolverEmbalagens: a pista explícita fica com UMA, e a outra vira sugestão com motivo", () => {
  const { mantidos, sugestoes } = resolverEmbalagens([
    { product_id: "lt-o", quantity: 1 },
    { product_id: "l5-o", quantity: 1 },
  ], catalogo, "2 thinner 4403 5L");
  assertEquals(mantidos.map((m) => m.product_id), ["l5-o"]);
  assertEquals(resolverEmbalagens([{ product_id: "lt-o" }, { product_id: "l5-o" }], catalogo, "4403 5L").ambiguos, 0);
  assertEquals(sugestoes.map((s) => s.product_id), ["lt-o"]);
});

Deno.test("resolverEmbalagens: pistas para duas embalagens do grupo = ambíguo (não escolhe a 1ª)", () => {
  const { mantidos } = resolverEmbalagens([
    { product_id: "lt-o", quantity: 1 },
    { product_id: "gl-o", quantity: 1 },
  ], catalogo, "4403 lata ou galão");
  assertEquals(mantidos, []);
});

Deno.test("resolverEmbalagens: item sozinho no grupo passa intacto", () => {
  const { mantidos, sugestoes } = resolverEmbalagens([{ product_id: "lt-o", quantity: 1 }], catalogo, "4403");
  assertEquals(mantidos.map((m) => m.product_id), ["lt-o"]);
  assertEquals(sugestoes, []);
});
