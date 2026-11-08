// 8.2 (Codex P2): as funções de página vão ao Chrome pelo TEXTO do `.toString()` que o DENO produz (a transpilação do
// edge runtime). Aqui cada uma é reavaliada a partir desse texto, sem o escopo do módulo, e EXECUTADA contra um
// documento mínimo: um helper injetado ou uma referência externa vira ReferenceError. O comportamento contra HTML real
// é provado em `scripts/sayerlack-portal-dom.test.ts` (vitest + jsdom).
import * as dom from "./sayerlack-portal-dom.ts";

function igual(a: unknown, e: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${msg}: esperado ${JSON.stringify(e)}, veio ${JSON.stringify(a)}`);
}

// deno-lint-ignore no-explicit-any
function viaTexto(fn: (...a: any[]) => any) {
  const src = fn.toString();
  if (src.includes("`")) throw new Error(`${fn.name}: crase no texto serializado`);
  return new Function(`return (${src});`);
}

const docVazio = { querySelector: () => null, querySelectorAll: () => [] };
const winVazio = { getComputedStyle: () => ({ display: "none" }), Event: class {} };

Deno.test("funções de página: o texto serializado roda sem o escopo do módulo", () => {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  g.document = docVazio;
  g.getComputedStyle = winVazio.getComputedStyle;
  const f = (fn: Parameters<typeof viaTexto>[0]) => viaTexto(fn)();
  try {
  igual(f(dom.lerTabelaConsultaDom)(), { ok: false, headers: [], linhas: [], processando: false, info: null, temProxima: false }, "tabela");
  igual(f(dom.lerSituacoesDom)(), [], "situações");
  igual(f(dom.lerCondicaoSelecionadaDom)(), false, "condição");
  igual(f(dom.lerCondicoesOpcoesDom)(), [], "opções");
  igual(f(dom.clicarFiltrarDom)(), undefined, "filtrar");
  igual(f(dom.clicarProximaPaginaDom)(), undefined, "próxima");
  igual(f(dom.aplicarFiltrosConsultaDom)("1", "", "", "2026-11-01").cliente, null, "filtros");
  } finally {
    delete g.document;
    delete g.getComputedStyle;
  }
});

Deno.test("laço de paginação: o texto serializado roda e soma as páginas", async () => {
  const ler = viaTexto(dom.lerTodasAsPaginas)();
  const paginas = [
    { ok: true, headers: ["Pedido"], linhas: [{ Pedido: "1" }], processando: false, info: null, temProxima: true },
    { ok: true, headers: ["Pedido"], linhas: [{ Pedido: "2" }], processando: false, info: null, temProxima: false },
  ];
  let i = 0;
  const r = await ler(async () => paginas[i], async (n: number) => { i = n - 1; return { ok: true }; }, 30);
  igual([r.ok, r.paginas, r.linhas.length], [true, 2, 2], "duas páginas");
});
