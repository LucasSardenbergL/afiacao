// Testa o CÓDIGO REAL de ordem-producao.ts no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-vendas-sync/ordem-producao_test.ts
import { agruparItensOp, lerRespostaOp, motivoDaFalhaOp, resumoOps, rotuloOp } from "./ordem-producao.ts";
import { OmieEscritaIndeterminada } from "../_shared/omie-chamada-relogio.ts";

function igual(veio: unknown, esperado: unknown, ctx: string) {
  const v = JSON.stringify(veio);
  const e = JSON.stringify(esperado);
  if (v !== e) throw new Error(`${ctx}: esperava ${e}, veio ${v}`);
}

// ── resposta do Omie ────────────────────────────────────────────────────────────────────────────

Deno.test("resposta sem nCodOP NÃO é OP criada (antes virava número \"null\")", () => {
  igual(lerRespostaOp(null), null, "null");
  igual(lerRespostaOp({}), null, "vazio");
  igual(lerRespostaOp({ nCodOP: 0 }), null, "zero");
  igual(lerRespostaOp({ cNumOP: "123" }), null, "só número, sem id");
});

Deno.test("o id interno nunca é apresentado como número da OP", () => {
  igual(lerRespostaOp({ nCodOP: 991, cNumOP: " 000123 " }), { id: 991, numero: "000123" }, "com cNumOP");
  igual(lerRespostaOp({ nCodOP: 991 }), { id: 991, numero: null }, "sem cNumOP");
  igual(lerRespostaOp({ nCodOP: "991", cNumOP: "" }), { id: 991, numero: null }, "id string");
  igual(rotuloOp(991, null), "OP de id 991 no Omie", "rótulo sem número");
  igual(rotuloOp(991, "000123"), "OP 000123", "rótulo com número");
});

// ── mesmo produto em duas linhas ───────────────────────────────────────────────────────────────

Deno.test("mesmo produto em duas linhas vira UMA OP com a soma e a data mais cedo", () => {
  const g = agruparItensOp([
    { omie_codigo_produto: 5, quantidade: 2, ready_by_date: "2026-12-10", descricao: "A" },
    { omie_codigo_produto: 7, quantidade: 1 },
    { omie_codigo_produto: 5, quantidade: 3, ready_by_date: "2026-12-03" },
  ], null);
  igual(g.map((i) => [i.omie_codigo_produto, i.quantidade, i.ready_by_date, i.invalido]), [
    [5, 5, "2026-12-03", null],
    [7, 1, null, null],
  ], "agrupado");
});

Deno.test("linha sem data herda o prazo do pedido ANTES de escolher a mais cedo (Codex P1)", () => {
  const g = agruparItensOp([
    { omie_codigo_produto: 5, quantidade: 1, ready_by_date: "2026-12-10" },
    { omie_codigo_produto: 5, quantidade: 1 },
  ], "2026-12-03");
  igual(g[0].ready_by_date, "2026-12-03", "prazo do pedido vence o mais tarde");
});

Deno.test("quantidade inválida numa linha derruba o produto inteiro — 5 + (−2) nunca vira 3 (Codex P0)", () => {
  const g = agruparItensOp([
    { omie_codigo_produto: 5, quantidade: 5 },
    { omie_codigo_produto: 5, quantidade: -2 },
  ], null);
  igual(g.length, 1, "um produto");
  igual(g[0].invalido, "quantidade inválida", "inválido");
  const z = agruparItensOp([{ omie_codigo_produto: 5, quantidade: 0 }], null);
  igual(z[0].invalido, "quantidade inválida", "zero");
  const n = agruparItensOp([{ omie_codigo_produto: 5, quantidade: Number.NaN }], null);
  igual(n[0].invalido, "quantidade inválida", "NaN");
});

Deno.test("item sem código Omie não se funde com outro e sai inválido", () => {
  const g = agruparItensOp([{ quantidade: 1 }, { quantidade: 2 }], null);
  igual(g.map((i) => i.invalido), ["produto sem código no Omie", "produto sem código no Omie"], "sem código");
});

Deno.test("agrupar não muta a entrada", () => {
  const entrada = [{ omie_codigo_produto: 5, quantidade: 2 }, { omie_codigo_produto: 5, quantidade: 3 }];
  agruparItensOp(entrada, null);
  igual(entrada[0].quantidade, 2, "entrada intacta");
});

// ── desfecho ───────────────────────────────────────────────────────────────────────────────────

Deno.test("uma falha já tira o success (antes era true incondicional)", () => {
  igual(resumoOps([
    { status: "criada", omie_ordem_id: 1, omie_ordem_numero: "1" },
    { status: "falhou", tipo: "indeterminado", motivo: "Omie recusou", chave: "OP_x_5" },
  ]), { success: false, falhas: 1 }, "com falha");
  igual(resumoOps([{ status: "criada", omie_ordem_id: 1, omie_ordem_numero: null }]), { success: true, falhas: 0 }, "sem falha");
});

Deno.test("data impossível não vence o prazo válido (2ª rodada do Codex)", () => {
  const [p] = agruparItensOp([
    { omie_codigo_produto: 9, quantidade: 1, ready_by_date: "2027-03-04" },
    { omie_codigo_produto: 9, quantidade: 1, ready_by_date: "2027-02-30" },
  ], null);
  igual(p.ready_by_date, "2027-03-04", "dia que não existe é ignorado");
  const [q] = agruparItensOp([{ omie_codigo_produto: 9, quantidade: 1, ready_by_date: "2027-02-30" }], "2027-05-01");
  igual(q.ready_by_date, "2027-05-01", "linha com dia impossível herda o prazo do pedido");
  const [r] = agruparItensOp([{ omie_codigo_produto: 9, quantidade: 1, ready_by_date: "2027-05-02T10:00:00Z" }], null);
  igual(r.ready_by_date, "2027-05-02", "timestamp vale pelo dia");
});

Deno.test("escrita indeterminada vira motivo SEM instrução de repetir (5ª rodada do Codex)", () => {
  const e = new OmieEscritaIndeterminada("IncluirOrdemProducao", "colacor", "estourou 25s", new Error("timeout"));
  if (!e.message.includes("antes de repetir")) throw new Error("pré-condição: o erro cru traz a instrução");
  const m = motivoDaFalhaOp(e);
  if (/repetir|confira/i.test(m)) throw new Error(`motivo ainda instrui: ${m}`);
  igual(m, "a chamada terminou sem confirmação do Omie (ele pode ter gravado)", "motivo neutro");
  igual(motivoDaFalhaOp(new Error("Produto sem estrutura")), "Produto sem estrutura", "erro comum passa");
  igual(motivoDaFalhaOp("cru"), "cru", "não-Error passa como texto");
});

// ── fiação no index.ts (a action não é executável fora do runtime da edge) ─────────────────────

Deno.test("fiação: criar_ordem_producao agrupa, lê a resposta e resume — sem success fixo nem número fabricado", async () => {
  const fonte = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const ini = fonte.indexOf('case "criar_ordem_producao"');
  const fim = fonte.indexOf('case "finalizar_ordem_producao"');
  if (ini < 0 || fim < ini) throw new Error("bloco criar_ordem_producao não encontrado");
  const bloco = fonte.slice(ini, fim);
  for (const s of ["agruparItensOp(", "lerRespostaOp(", "resumoOps(", "desfecho: desfechosOp", "opItem.invalido", "else if (insErr)"]) {
    if (!bloco.includes(s)) throw new Error(`fiação perdida: ${s}`);
  }
  if (/result\s*=\s*\{\s*success:\s*true/.test(bloco)) throw new Error("success:true incondicional voltou");
  if (bloco.includes("String(omieOrdemId)")) throw new Error("número \"null\" fabricado voltou");
});

Deno.test("fiação: produto inválido NÃO grava linha local executável e cada falha diz o tipo (2ª rodada do Codex)", async () => {
  const fonte = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const bloco = fonte.slice(fonte.indexOf('case "criar_ordem_producao"'), fonte.indexOf('case "finalizar_ordem_producao"'));
  const iInvalido = bloco.indexOf("if (opItem.invalido) {");
  const iInsert = bloco.indexOf('from("production_orders").insert(');
  if (iInvalido < 0 || iInsert < 0 || iInvalido > iInsert) throw new Error("o desvio do inválido tem de vir ANTES do insert");
  const desvio = bloco.slice(iInvalido, iInsert);
  if (!/tipo: "invalido"[\s\S]*continue;/.test(desvio)) throw new Error("inválido sem desfecho tipado ou sem pular o insert");
  for (const t of ['tipo: "indeterminado"', 'tipo: "sem_registro_local"']) {
    if (!bloco.includes(t)) throw new Error(`desfecho sem tipo: ${t}`);
  }
  if (!bloco.includes("motivoFalha = motivoDaFalhaOp(opErr);")) throw new Error("catch da OP sem motivoDaFalhaOp (mensagem crua volta)");
  // 3ª rodada do Codex: o indeterminado leva a quantidade da OP AGREGADA (a conferência no Omie é pelo total).
  if (!/tipo: "indeterminado"[^}]*quantidade: opItem\.quantidade/.test(bloco)) throw new Error("indeterminado sem a quantidade agregada");
});
