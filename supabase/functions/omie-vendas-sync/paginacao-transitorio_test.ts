// GUARDA: toda listagem PAGINADA do Omie nesta edge passa `{ throwOnTransient: true }`.
//
// Por quê: `callOmieVendasApi` devolve `null` em dois casos — "Não existem registros" (fim real)
// e rate-limit/transitório que ESGOTOU os retries. Sem `throwOnTransient`, os dois são o mesmo
// `null`, e um laço paginado lê o transitório como FIM DOS DADOS: a importação para no meio e
// grava sucesso (incidente: fin_sync_log 81346900-f8ca-459d-8e83-148f804f03c0, colacor
// 2026-10-13 20:20 — transitório na pág 1, 0 pedidos gravados, status 'complete'; conserto
// #1597 + v1.31/#3519). Com a opção, o transitório vira throw `OMIE_TRANSIENT`, que o laço trata
// como PAUSA (não completa) e o desfecho do incremental transforma em 500 + log 'error'
// (desfecho-pedidos.ts).
//
// O que faltava: tirar o `throwOnTransient` do `ListarPedidos` do `syncPedidos` passava VERDE em
// toda a suíte (falsificado em 2026-11-14 contra edge-money-path-invariants + paginacao-artesanal
// + desfecho-pedidos + pagination). Este teste fecha isso para TODAS as listagens com página
// variável, não só uma.
//
// "Paginada" = a chamada NÃO fixa `pagina: 1` no literal (página variável ou params montados num
// identificador do laço). Lookup de página única (`pagina: 1`) fica fora: ali o `null` é "não
// achei", outra semântica, decidida no chamador.

const FONTE = new URL("./index.ts", import.meta.url);

function assert(cond: boolean, msg = "assert falhou"): asserts cond {
  if (!cond) throw new Error(msg);
}

interface Chamada { linha: number; metodo: string; texto: string }

/** Extrai cada `callOmieVendasApi(...)` (exceto a definição) por casamento de parênteses. */
function extrairChamadas(src: string): Chamada[] {
  const out: Chamada[] = [];
  const re = /callOmieVendasApi\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue; // a definição
    let i = m.index + m[0].length;
    let prof = 1;
    while (prof > 0 && i < src.length) {
      const c = src[i++];
      if (c === "(") prof++;
      else if (c === ")") prof--;
    }
    const texto = src.slice(m.index, i);
    const metodo = texto.match(/^callOmieVendasApi\(\s*"[^"]*"\s*,\s*"(\w+)"/)?.[1] ?? "?";
    out.push({ linha: src.slice(0, m.index).split("\n").length, metodo, texto });
  }
  return out;
}

function ehListagemPaginada(c: Chamada): boolean {
  return c.metodo.startsWith("Listar") && !/\bn?[pP]agina:\s*1\b/.test(c.texto);
}

function paginadasSemThrowOnTransient(src: string): Chamada[] {
  return extrairChamadas(src)
    .filter(ehListagemPaginada)
    .filter((c) => !/throwOnTransient:\s*true/.test(c.texto));
}

Deno.test("toda listagem paginada do Omie passa { throwOnTransient: true } — transitório esgotado não vira fim dos dados", () => {
  const src = Deno.readTextFileSync(FONTE);
  const paginadas = extrairChamadas(src).filter(ehListagemPaginada);
  // Piso: hoje são 7 (ListarProdutos, ListarPosEstoque, ListarClientes do lookup estrito,
  // ListarParcelas, ListarPedidos do syncPedidos, do backfill e do backfill de exclusão). Se o
  // extrator parar de achá-las, o teste ficaria verde por vacuidade — reprova.
  assert(paginadas.length >= 7, `extrator achou só ${paginadas.length} listagem(ns) paginada(s) — esperado >= 7`);
  const metodos = new Set(paginadas.map((c) => c.metodo));
  for (const m of ["ListarPedidos", "ListarProdutos", "ListarPosEstoque", "ListarParcelas", "ListarClientes"]) {
    assert(metodos.has(m), `extrator não achou a listagem paginada ${m}`);
  }
  const faltando = paginadasSemThrowOnTransient(src);
  assert(
    faltando.length === 0,
    "LISTAGEM_PAGINADA_SEM_THROW_ON_TRANSIENT: " +
      faltando.map((c) => `index.ts:${c.linha} ${c.metodo}`).join(", ") +
      " — sem a opção, rate-limit esgotado devolve null e o laço lê como fim dos dados (truncamento silencioso)",
  );
});

Deno.test("syncPedidos: OMIE_TRANSIENT no ListarPedidos PAUSA o laço sem marcar fim real", () => {
  const src = Deno.readTextFileSync(FONTE);
  const ini = src.indexOf("while (pagesProcessed < maxPages) {");
  assert(ini > 0, "laço de paginação do syncPedidos não encontrado");
  const fimReal = src.indexOf("reachedEnd = true;", ini);
  assert(fimReal > ini, "marcação de fim real do syncPedidos não encontrada");
  const trecho = src.slice(ini, fimReal);
  const ramo = trecho.indexOf("if (msg.startsWith('OMIE_TRANSIENT')) {");
  assert(ramo > 0, "o catch do ListarPedidos deixou de separar OMIE_TRANSIENT");
  const fimRamo = trecho.indexOf("if (cursor) {", ramo);
  assert(fimRamo > ramo, "fim do ramo transitório não encontrado");
  const corpoRamo = trecho.slice(ramo, fimRamo);
  assert(/lastErrorKind = classifyOmieTransient\(msg\);/.test(corpoRamo), "ramo transitório não registra lastErrorKind");
  assert(/\bbreak;/.test(corpoRamo), "ramo transitório não pausa o laço");
  assert(!corpoRamo.includes("reachedEnd"), "ramo transitório voltou a marcar fim real");
});

Deno.test("controle: o detector acusa listagem paginada sem a opção e ignora lookup de página única", () => {
  const fixture = `
    async function callOmieVendasApi(endpoint: string) {}
    const a = await callOmieVendasApi("produtos/pedido/", "ListarPedidos", listParams, account);
    const b = await callOmieVendasApi("geral/produtos/", "ListarProdutos", { pagina, x: f(1) }, account, { throwOnTransient: true });
    const c = await callOmieVendasApi("geral/clientes/", "ListarClientes", { pagina: 1, registros_por_pagina: 5 }, account);
    const d = await callOmieVendasApi("estoque/consulta/", "ListarPosEstoque", { nPagina: pagina }, account);
  `;
  const achados = paginadasSemThrowOnTransient(fixture).map((c) => c.metodo).sort();
  assert(
    JSON.stringify(achados) === JSON.stringify(["ListarPedidos", "ListarPosEstoque"]),
    `controle: esperado [ListarPedidos, ListarPosEstoque], veio ${JSON.stringify(achados)}`,
  );
});
