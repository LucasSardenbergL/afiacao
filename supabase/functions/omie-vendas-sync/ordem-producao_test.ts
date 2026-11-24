// Testa o CÓDIGO REAL de ordem-producao.ts no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-vendas-sync/ordem-producao_test.ts
import {
  agruparItensOp,
  type LinhaOpLocal,
  lerRespostaOp,
  linhaDoItem,
  motivoParaNaoChamar,
  planoDoItem,
  resumoOps,
} from "./ordem-producao.ts";

function igual(veio: unknown, esperado: unknown, ctx: string) {
  const v = JSON.stringify(veio);
  const e = JSON.stringify(esperado);
  if (v !== e) throw new Error(`${ctx}: esperava ${e}, veio ${v}`);
}

const linha = (p: Partial<LinhaOpLocal>): LinhaOpLocal => ({
  id: "l1", product_id: null, product_codigo: null, omie_ordem_producao_id: null, omie_ordem_numero: null, ...p,
});

// ── resposta do Omie ────────────────────────────────────────────────────────────────────────────

Deno.test("resposta sem nCodOP NÃO é OP criada (antes virava número \"null\")", () => {
  igual(lerRespostaOp(null), null, "null");
  igual(lerRespostaOp({}), null, "vazio");
  igual(lerRespostaOp({ nCodOP: 0 }), null, "zero");
  igual(lerRespostaOp({ cNumOP: "123" }), null, "só número, sem id");
});

Deno.test("resposta com nCodOP: usa o cNumOP, senão o próprio id", () => {
  igual(lerRespostaOp({ nCodOP: 991, cNumOP: " 000123 " }), { id: 991, numero: "000123" }, "com cNumOP");
  igual(lerRespostaOp({ nCodOP: 991 }), { id: 991, numero: "991" }, "sem cNumOP");
  igual(lerRespostaOp({ nCodOP: "991", cNumOP: "" }), { id: 991, numero: "991" }, "id string");
});

// ── idempotência / retomar só o que falhou ─────────────────────────────────────────────────────

Deno.test("linha local COM OP no Omie → pular (não chama o Omie de novo)", () => {
  const l = linha({ product_id: "p1", omie_ordem_producao_id: 77, omie_ordem_numero: "77" });
  igual(planoDoItem({ product_id: "p1", quantidade: 1 }, [l]).acao, "pular", "pular");
});

Deno.test("linha local SEM OP → reenviar na MESMA linha (não insere outra)", () => {
  const l = linha({ id: "l9", product_id: "p1" });
  const p = planoDoItem({ product_id: "p1", quantidade: 1 }, [l]);
  igual(p.acao, "reenviar", "acao");
  igual(p.acao === "reenviar" ? p.linha.id : null, "l9", "mesma linha");
});

Deno.test("sem linha local → criar", () => {
  igual(planoDoItem({ product_id: "p2", quantidade: 1 }, [linha({ product_id: "p1" })]).acao, "criar", "criar");
});

Deno.test("casa pelo código quando o item ou a linha não tem product_id", () => {
  const semId = linha({ id: "c1", product_codigo: "PA-01" });
  igual(linhaDoItem({ codigo: "PA-01", quantidade: 1 }, [semId])?.id, "c1", "item sem id");
  igual(linhaDoItem({ product_id: "p1", codigo: "PA-01", quantidade: 1 }, [semId])?.id, "c1", "linha sem id");
});

Deno.test("nunca casa dois product_id DIFERENTES só porque o código é igual", () => {
  const outra = linha({ product_id: "pX", product_codigo: "PA-01" });
  igual(linhaDoItem({ product_id: "p1", codigo: "PA-01", quantidade: 1 }, [outra]), undefined, "ids diferentes");
});

// ── mesmo produto em duas linhas ───────────────────────────────────────────────────────────────

Deno.test("mesmo produto em duas linhas vira UMA OP com a soma e a data mais cedo", () => {
  const g = agruparItensOp([
    { omie_codigo_produto: 5, quantidade: 2, ready_by_date: "2026-12-10", descricao: "A" },
    { omie_codigo_produto: 7, quantidade: 1 },
    { omie_codigo_produto: 5, quantidade: 3, ready_by_date: "2026-12-03" },
  ]);
  igual(g.map((i) => [i.omie_codigo_produto, i.quantidade, i.ready_by_date ?? null]), [
    [5, 5, "2026-12-03"],
    [7, 1, null],
  ], "agrupado");
});

Deno.test("agrupar não muta a entrada", () => {
  const entrada = [{ omie_codigo_produto: 5, quantidade: 2 }, { omie_codigo_produto: 5, quantidade: 3 }];
  agruparItensOp(entrada);
  igual(entrada[0].quantidade, 2, "entrada intacta");
});

Deno.test("item sem código Omie não se funde com outro e falha antes de chamar", () => {
  const g = agruparItensOp([{ quantidade: 1 }, { quantidade: 2 }]);
  igual(g.length, 2, "não funde");
  igual(motivoParaNaoChamar({ quantidade: 1 }), "produto sem código no Omie", "sem código");
  igual(motivoParaNaoChamar({ omie_codigo_produto: 5, quantidade: 0 }), "quantidade inválida", "qtd 0");
  igual(motivoParaNaoChamar({ omie_codigo_produto: 5, quantidade: 2 }), null, "ok");
});

// ── desfecho ───────────────────────────────────────────────────────────────────────────────────

Deno.test("uma falha já tira o success (antes era true incondicional)", () => {
  igual(resumoOps([
    { status: "criada", omie_ordem_id: 1, omie_ordem_numero: "1" },
    { status: "falhou", motivo: "Omie recusou" },
  ]), { success: false, falhas: 1 }, "com falha");
  igual(resumoOps([
    { status: "criada", omie_ordem_id: 1, omie_ordem_numero: "1" },
    { status: "ja_existia", omie_ordem_id: 2, omie_ordem_numero: null },
  ]), { success: true, falhas: 0 }, "sem falha");
});

// ── fiação no index.ts (a action não é executável fora do runtime da edge) ─────────────────────

Deno.test("fiação: criar_ordem_producao usa o plano, a leitura da resposta e o resumo — sem success fixo", async () => {
  const fonte = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const ini = fonte.indexOf('case "criar_ordem_producao"');
  const fim = fonte.indexOf('case "finalizar_ordem_producao"');
  if (ini < 0 || fim < ini) throw new Error("bloco criar_ordem_producao não encontrado");
  const bloco = fonte.slice(ini, fim);
  for (const s of ["agruparItensOp(", "planoDoItem(", "lerRespostaOp(", "motivoParaNaoChamar(", "resumoOps(", "desfecho: desfechosOp"]) {
    if (!bloco.includes(s)) throw new Error(`fiação perdida: ${s}`);
  }
  if (/result\s*=\s*\{\s*success:\s*true/.test(bloco)) throw new Error("success:true incondicional voltou");
  if (bloco.includes("String(omieOrdemId)")) throw new Error("número \"null\" fabricado voltou");
  if (!/if \(opLinhasErr\) throw/.test(bloco)) throw new Error("leitura das OPs existentes que falha não pode virar 'nenhuma'");
});
