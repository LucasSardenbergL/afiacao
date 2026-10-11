// Roda com: deno test --no-remote supabase/functions/picking-fila-omie/coleta_test.ts
import {
  codigoOmie,
  conferirFiltro,
  dataOmieParaIso,
  faultDeFimDePagina,
  montarLote,
  normalizarPedido,
  type Pagina,
  paginar,
  quantidadeTexto,
  resumirLeitura,
} from "./coleta.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

function ped(codigo: number | string | null, dInc = "05/10/2026", det: unknown[] = [item(1)]) {
  return {
    cabecalho: { codigo_pedido: codigo, numero_pedido: `N${codigo}` },
    infoCadastro: { dInc, dAlt: "06/10/2026", hAlt: "10:00:00" },
    det,
  };
}

function item(ci: number, extra: Record<string, unknown> = {}) {
  return {
    ide: { codigo_item: ci },
    produto: { codigo_produto: 900 + ci, codigo: `P${ci}`, descricao: "Lixa", quantidade: 2, unidade: "UN", ean: "789", ...extra },
  };
}

function pagina(total: number, pedidos: unknown[]): Pagina {
  return { tipo: "corpo", corpo: { total_de_registros: total, pedido_venda_produto: pedidos } };
}

/** Lister de mentira: devolve as páginas em ordem e conta as chamadas. */
function lister(paginas: Pagina[]) {
  const chamadas: number[] = [];
  return {
    chamadas,
    listar: (n: number) => {
      chamadas.push(n);
      return Promise.resolve(paginas[n - 1] ?? { tipo: "corpo", corpo: { total_de_registros: 0, pedido_venda_produto: [] } } as Pagina);
    },
  };
}

Deno.test("codigoOmie: inteiro positivo seguro ou texto de dígitos; o resto é null", () => {
  assertEquals([codigoOmie(12), codigoOmie("0012"), codigoOmie("12"), codigoOmie(0), codigoOmie(1.5), codigoOmie(null)], [
    "12",
    null,
    "12",
    null,
    null,
    null,
  ]);
  assertEquals(codigoOmie(2 ** 60), null, "acima do inteiro seguro do JS não é aceito (perderia dígitos)");
});

Deno.test("quantidadeTexto: número vira texto sem arredondar; ausente é null, nunca 0", () => {
  assertEquals([quantidadeTexto(2), quantidadeTexto(1.25), quantidadeTexto("3.5"), quantidadeTexto(null)], ["2", "1.25", "3.5", null]);
  assertEquals(quantidadeTexto(1e-7), "1e-7", "notação científica passa como veio — o banco recusa (bloqueado_dado)");
});

Deno.test("dataOmieParaIso: dd/mm/aaaa válida; data impossível ou fora do formato = null", () => {
  assertEquals([dataOmieParaIso("05/10/2026"), dataOmieParaIso("31/02/2026"), dataOmieParaIso("2026-10-05"), dataOmieParaIso("")], [
    "2026-10-05",
    null,
    null,
    null,
  ]);
});

Deno.test("normalizarPedido: monta o formato da RPC; item malformado passa com null para o banco decidir", () => {
  const n = normalizarPedido(ped(77, "05/10/2026", [item(1), { ide: {}, produto: { quantidade: null } }]));
  assertEquals(n?.codigo_pedido, "77");
  assertEquals(n?.cliente_nome, null, "a listagem não traz nome do cliente");
  assertEquals(n?.itens[0], { codigo_item: "1", codigo_produto: "901", codigo: "P1", descricao: "Lixa", quantidade: "2", unidade: "UN", ean: "789" });
  assertEquals(n?.itens[1], { codigo_item: null, codigo_produto: null, codigo: null, descricao: null, quantidade: null, unidade: null, ean: null });
  assertEquals(normalizarPedido(ped(null)), null, "sem codigo_pedido não há pedido");
});

Deno.test("faultDeFimDePagina: 'Não existem registros' é fim; REDUNDANT não", () => {
  assertEquals(faultDeFimDePagina("ERROR: Não existem registros para a página [3]!"), true);
  assertEquals(faultDeFimDePagina("Consumo redundante detectado. Aguarde 5 segundos (REDUNDANT)"), false);
});

Deno.test("paginar: vai até a página vazia (não confia em total_de_paginas) e fica completa", async () => {
  const l = lister([pagina(3, [ped(1), ped(2)]), pagina(3, [ped(3)])]);
  const r = await paginar(l.listar, { tetoPaginas: 10 });
  if (!r.ok) throw new Error(r.erro);
  assertEquals(l.chamadas, [1, 2, 3], "a 3ª chamada é a página vazia que prova o fim");
  assertEquals([r.listagem.presentes, r.listagem.total_de_registros, r.listagem.completa], [["1", "2", "3"], 3, true]);
});

Deno.test("paginar: o 'não existem registros' encerra como página vazia", async () => {
  const l = lister([pagina(1, [ped(1)]), { tipo: "fim" }]);
  const r = await paginar(l.listar, { tetoPaginas: 10 });
  if (!r.ok) throw new Error(r.erro);
  assertEquals([r.listagem.paginas, r.listagem.completa], [2, true]);
});

Deno.test("paginar: página mutável — pedido empurrado para a página seguinte se repete → incompleta", async () => {
  // Entrou um pedido novo na frente entre a página 1 e a 2: o último da 1 reaparece na 2 e o total muda.
  const l = lister([pagina(3, [ped(1), ped(2)]), pagina(4, [ped(2), ped(3)])]);
  const r = await paginar(l.listar, { tetoPaginas: 10 });
  if (!r.ok) throw new Error(r.erro);
  assertEquals(r.listagem.completa, false);
  assertEquals(r.listagem.motivos_incompleta, ["codigo_repetido_entre_paginas", "total_de_registros_mudou_entre_paginas"]);
  assertEquals(r.listagem.presentes, ["1", "2", "2", "3"], "a repetição vai ao banco — ele recusa a completude sozinho");
});

Deno.test("paginar: página mutável — um pedido saiu e o total bate por coincidência → a repetição denuncia", async () => {
  // Total estável em 3, mas o pedido 9 saiu e o 2 deslizou: 1,2 | 2,3 — 4 lidos para total 3.
  const l = lister([pagina(3, [ped(1), ped(2)]), pagina(3, [ped(2), ped(3)])]);
  const r = await paginar(l.listar, { tetoPaginas: 10 });
  if (!r.ok) throw new Error(r.erro);
  assertEquals(r.listagem.motivos_incompleta, ["codigo_repetido_entre_paginas", "presentes_diferente_do_total"]);
});

Deno.test("paginar: página mutável — um pedido deslizou para trás e sumiu da leitura → total denuncia", async () => {
  const l = lister([pagina(4, [ped(1), ped(2)]), pagina(4, [ped(4)])]);
  const r = await paginar(l.listar, { tetoPaginas: 10 });
  if (!r.ok) throw new Error(r.erro);
  assertEquals(r.listagem.motivos_incompleta, ["presentes_diferente_do_total"]);
});

Deno.test("paginar: erro numa página (REDUNDANT, timeout) aborta a coleta inteira — nada parcial", async () => {
  const l = lister([pagina(4, [ped(1), ped(2)]), { tipo: "erro", erro: "Consumo redundante detectado (REDUNDANT)" }]);
  const r = await paginar(l.listar, { tetoPaginas: 10 });
  assertEquals(r.ok, false);
  if (r.ok) return;
  assertEquals(r.erro, "página 2: Consumo redundante detectado (REDUNDANT)");
  assertEquals(l.chamadas, [1, 2], "não re-tenta nem segue para a página 3");
});

Deno.test("paginar: resposta atrasada não muda a ordem — a página seguinte só sai depois da anterior", async () => {
  const ordem: string[] = [];
  const r = await paginar(async (n) => {
    ordem.push(`ini${n}`);
    if (n === 1) await new Promise((res) => setTimeout(res, 20));
    ordem.push(`fim${n}`);
    return n === 1 ? pagina(1, [ped(1)]) : { tipo: "fim" };
  }, { tetoPaginas: 5, entrePaginas: () => Promise.resolve(void ordem.push("tregua")) });
  assertEquals(r.ok, true);
  assertEquals(ordem, ["ini1", "fim1", "tregua", "ini2", "fim2"]);
});

Deno.test("paginar: teto de páginas sem página vazia é erro, não listagem", async () => {
  // Sem fim; da página 20 em diante dá erro, para o teste FALHAR (e não pendurar) se o teto sumir.
  const sempre = (n: number): Promise<Pagina> =>
    Promise.resolve(n < 20 ? pagina(999, [ped(n)]) : { tipo: "erro", erro: "passou do teto" });
  const r = await paginar(sempre, { tetoPaginas: 3 });
  assertEquals([r.ok, r.ok ? null : r.erro], [false, "teto de 3 páginas atingido sem página vazia"]);
});

Deno.test("paginar: registro sem codigo_pedido ou página sem total → incompleta", async () => {
  const a = await paginar(lister([pagina(2, [ped(1), ped(null)])]).listar, { tetoPaginas: 5 });
  if (!a.ok) throw new Error(a.erro);
  assertEquals(a.listagem.motivos_incompleta, ["presentes_diferente_do_total", "registro_sem_codigo_pedido"]);
  const b = await paginar(lister([{ tipo: "corpo", corpo: { pedido_venda_produto: [ped(1)] } }]).listar, { tetoPaginas: 5 });
  if (!b.ok) throw new Error(b.erro);
  assertEquals(b.listagem.motivos_incompleta, ["pagina_sem_total_de_registros", "sem_total_de_registros"]);
});

Deno.test("montarLote: corte decide a admissão; acompanhado presente entra mesmo fora do corte; dInc ausente não admite", () => {
  const regs = [ped(10, "11/09/2026"), ped(11, "10/09/2026"), ped(12, "10/09/2026"), ped(13, ""), ped(14, "01/01/2020")];
  const lote = montarLote(regs, "2026-09-11", new Set(["12", "14"]));
  assertEquals(lote.pedidos.map((p) => p.codigo_pedido), ["10", "12", "14"]);
  assertEquals([lote.admitidos_pelo_corte, lote.acompanhados_presentes, lote.fora_do_corte, lote.sem_data_inclusao], [1, 2, 2, 1]);
});

Deno.test("montarLote: repetido entre páginas sai uma vez só (o banco recusa duplicata em p_pedidos)", () => {
  const lote = montarLote([ped(5, "01/10/2026", [item(1)]), ped(5, "01/10/2026", [item(1), item(2)])], "2026-09-01", new Set());
  assertEquals(lote.pedidos.length, 1);
  assertEquals(lote.pedidos[0].itens.length, 2, "fica a leitura mais recente");
});

Deno.test("montarLote: ordena por código numérico, não lexicográfico", () => {
  const lote = montarLote([ped(100), ped(20), ped(3)], "2026-01-01", new Set());
  assertEquals(lote.pedidos.map((p) => p.codigo_pedido), ["3", "20", "100"]);
});

Deno.test("resumirLeitura: conta itens ilegíveis e o dInc anterior ao corte que o filtro deixou passar", () => {
  const listagem = {
    registros: [ped(1, "01/10/2026", [item(1), item(2, { ean: null, unidade: "" })]), ped(2, "15/08/2026"), ped(3, "02/10/2026", [])],
    presentes: ["1", "2", "3"],
    total_de_registros: 3,
    paginas: 2,
    completa: true,
    motivos_incompleta: [],
  };
  const r = resumirLeitura(listagem, "2026-09-11");
  assertEquals([r.admitidos_pelo_corte, r.fora_do_corte, r.dinc_antes_do_corte, r.dinc_mais_antigo], [2, 1, 1, "2026-08-15"]);
  assertEquals([r.linhas, r.linhas_sem_unidade, r.linhas_com_ean, r.pedidos_sem_itens], [2, 1, 1, 1]);
});

Deno.test("conferirFiltro: recente no corte ausente do filtro é perdido; cobertura exige dInc anterior ao corte", () => {
  const amostra = [ped(30, "05/10/2026"), ped(29, "20/09/2026"), ped(28, "01/09/2026"), ped(27, "")];
  const r = conferirFiltro(amostra, new Set(["30"]), "2026-09-11");
  assertEquals([r.amostra_no_corte, r.perdidos_pelo_filtro, r.perdidos_amostra, r.amostra_cobre_a_janela], [2, 1, ["29"], true]);
  const s = conferirFiltro([ped(30, "05/10/2026")], new Set(["30"]), "2026-09-11");
  assertEquals([s.perdidos_pelo_filtro, s.amostra_cobre_a_janela], [0, false], "amostra só de recentes não prova a janela");
});
