// `assertEquals` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}
import {
  classificar,
  dataBRparaISO,
  inicioDaJanela,
  lerListaConsulta,
  motivoBloqueio,
  aplicarCarencia,
  contratosDoTexto,
  SITUACOES_IMPORTAVEIS,
  portalSayerlackFechado,
  resumoImportacao,
  situacaoCancelada,
  desfechoNoPortal,
  idDoPo,
  janelaDeLeitura,
  marcadorFresco,
  pedidosAReconciliar,
  type PedidoDisparadoLido,
  provarLeitura,
  totalAnunciado,
  carenciaTravada,
  reconsultasForaDaJanela,
  type PedidoClassificado,
} from "./varredura.ts";
import * as leituraOriginal from "../sayerlack-importar-pedido-portal/leitura.ts";
import * as janelaOriginal from "../disparar-pedidos-aprovados/janela-portal.ts";

const linha = (pedido: string, situacao: string, emissao: string, extra: Record<string, string> = {}) => ({
  "Estab": "CAJ", "Pedido": pedido, "Pedido Clien": pedido, "Cliente": "OBEN COMERCIO LTDA", "Situação": situacao,
  "Data Emissão": emissao, "Data Entrega": "26/10/2026", "Vlr Mercadori": "100,0000", "Vlr Total": "106,5000", ...extra,
});

Deno.test("paridade: cópias locais = funções originais das outras edges", () => {
  for (const s of ["26/10/2026", "31/02/2026", "2026-10-26", " 01/01/2020 ", "", "x"]) {
    assertEquals(dataBRparaISO(s), leituraOriginal.dataBRparaISO(s));
  }
  for (const s of ["6 - Cancelado", "Cancelado", "5 - Suspenso", "16 - Outro", "6 -", ""]) {
    assertEquals(situacaoCancelada(s), leituraOriginal.situacaoCancelada(s));
  }
  // Uma semana inteira, de hora em hora (UTC), cobre as bordas sáb 12h e seg 6h de SP.
  const t0 = Date.UTC(2026, 9, 17, 0, 0); // sábado 17/10/2026 00:00 UTC
  for (let h = 0; h < 24 * 7; h++) {
    const d = new Date(t0 + h * 3600_000);
    if (portalSayerlackFechado(d) !== janelaOriginal.portalSayerlackFechado(d)) throw new Error(`diverge em ${d.toISOString()}`);
  }
});

Deno.test("horários do cron: sábado 12:30 SP cai no portal fechado; os outros dias abertos", () => {
  // 15:30 UTC = 12:30 SP · 20:30 UTC = 17:30 SP · 01:30 UTC (dia seguinte) = 22:30 SP.
  assertEquals(portalSayerlackFechado(new Date("2026-10-17T15:30:00Z")), true); // sáb 12:30
  assertEquals(portalSayerlackFechado(new Date("2026-10-16T15:30:00Z")), false); // sex 12:30
  assertEquals(portalSayerlackFechado(new Date("2026-10-17T01:30:00Z")), false); // sex 22:30
  assertEquals(portalSayerlackFechado(new Date("2026-10-19T01:30:00Z")), true); // dom 22:30
  assertEquals(portalSayerlackFechado(new Date("2026-10-19T15:30:00Z")), false); // seg 12:30
});

Deno.test("lista: coluna Pedido EXATA, nº ilegível contado, nº repetido sai (ambíguo)", () => {
  const r = lerListaConsulta([
    linha("2141068", "5 - Suspenso", "15/10/2026"),
    linha("2141070", "1 - Aberto", "16/10/2026", { "Pedido": "", "Pedido Clien": "2141070" }),
    linha("2141071", "1 - Aberto", "16/10/2026"),
    linha("2141071", "1 - Aberto", "16/10/2026"),
  ]);
  assertEquals(r.pedidos, [{ protocolo: "2141068", situacao: "5 - Suspenso", situacao_codigo: "5", emissao: "2026-10-15" }]);
  assertEquals(r.ilegiveis, 1);
  assertEquals(r.repetidos, ["2141071"]);
});

const ctxBase = {
  protocolosNoApp: new Set(["100"]),
  contratosNoOmie: new Set(["200"]),
  situacoesImportaveis: new Set(["1"]),
  emissaoDesde: "2026-10-10",
};

Deno.test("classificação: existente no app/Omie, cancelado, janela, situação fora da lista fechada", () => {
  const { pedidos } = lerListaConsulta([
    linha("100", "1 - Aberto", "15/10/2026"),
    linha("200", "1 - Aberto", "15/10/2026"),
    linha("300", "6 - Cancelado", "15/10/2026"),
    linha("400", "1 - Aberto", "09/10/2026"),
    linha("500", "4 - Faturado", "15/10/2026"),
    linha("600", "Aberto", "15/10/2026"), // sem código: não casa a lista fechada
    linha("700", "1 - Aberto", "15/10/2026"),
    linha("800", "1 - Aberto", "data?"), // emissão ilegível: fora (não presume que é recente)
  ]);
  assertEquals(classificar(pedidos, ctxBase).map((p) => `${p.protocolo}:${p.classe}`), [
    "100:ja_no_app", "200:ja_no_omie", "300:cancelado", "400:fora_da_janela",
    "500:situacao_nao_importavel", "600:situacao_nao_importavel", "700:candidato", "800:fora_da_janela",
  ]);
});

Deno.test("lista fechada VAZIA (estado de partida) = nenhum candidato, só relatório", () => {
  const { pedidos } = lerListaConsulta([linha("700", "1 - Aberto", "15/10/2026")]);
  assertEquals(classificar(pedidos, { ...ctxBase, situacoesImportaveis: new Set() })[0].classe, "situacao_nao_importavel");
});

Deno.test("bloqueio: qualquer pedido em voo/conciliação bloqueia; os demais estados não", () => {
  assertEquals(motivoBloqueio([{ id: 1, status_envio_portal: "sucesso_portal" }, { id: 2, status_envio_portal: null }]), null);
  for (const st of ["enviando_portal", "aceito_portal_sem_protocolo", "indeterminado_requer_conciliacao"]) {
    const m = motivoBloqueio([{ id: 9, status_envio_portal: st }]);
    if (!m || !m.includes(`#9 (${st})`)) throw new Error(`${st} não bloqueou: ${m}`);
  }
});

Deno.test("janela de 7 dias contando hoje, inclusive virada de mês", () => {
  assertEquals(inicioDaJanela("2026-10-16"), "2026-10-10");
  assertEquals(inicioDaJanela("2026-11-03"), "2026-10-28");
});

Deno.test("contrato do Omie: btrim como a RPC, composto 'a/b' conta os dois, lixo some", () => {
  assertEquals(
    [contratosDoTexto(" 2141068 "), contratosDoTexto("1998739/1998740"), contratosDoTexto("AFI26050780"), contratosDoTexto(""), contratosDoTexto(null)],
    [["2141068"], ["1998739", "1998740"], [], [], []],
  );
});

Deno.test("lista do founder: cron importa só 1 Aberto e 5 Suspenso; 2/3 Atendido viram aviso; 4, 6, 7 fora", () => {
  assertEquals([...SITUACOES_IMPORTAVEIS].sort(), ["1", "5"]);
  const { pedidos } = lerListaConsulta([
    linha("801", "1 - Aberto", "15/10/2026"), linha("802", "2 - Atendido Parcial", "15/10/2026"),
    linha("803", "3 - Atendido Total", "15/10/2026"), linha("804", "4 - Pendentes", "15/10/2026"),
    linha("805", "5 - Suspenso", "15/10/2026"), linha("807", "7 - Fatur Balcão", "15/10/2026"),
    linha("100", "3 - Atendido Total", "15/10/2026"), // já no app: não avisa
  ]);
  assertEquals(classificar(pedidos, { ...ctxBase, situacoesImportaveis: SITUACOES_IMPORTAVEIS }).map((p) => `${p.protocolo}:${p.classe}`), [
    "801:candidato", "802:atendido_conferir", "803:atendido_conferir", "804:situacao_nao_importavel",
    "805:candidato", "807:situacao_nao_importavel", "100:ja_no_app",
  ]);
});

Deno.test("resultado da importação: só ok=true com HTTP 2xx é sucesso", () => {
  assertEquals(resumoImportacao(200, { ok: true, mensagem: "x" }).ok, true);
  assertEquals(resumoImportacao(200, { ok: false, mensagem: "Há item sem de-para" }), { ok: false, mensagem: "Há item sem de-para" });
  assertEquals(resumoImportacao(500, { ok: true }).ok, false);
  assertEquals(resumoImportacao(502, "lixo").mensagem, "resposta HTTP 502 sem mensagem");
});

Deno.test("carência: 1ª vista espera; visto antes sem sync complete depois espera; com sync depois (+5 min) importa", () => {
  const { pedidos } = lerListaConsulta([linha("701", "1 - Aberto", "15/10/2026"), linha("702", "1 - Aberto", "15/10/2026"),
    linha("703", "1 - Aberto", "15/10/2026"), linha("704", "1 - Aberto", "15/10/2026")]);
  const cls = classificar(pedidos, { ...ctxBase, situacoesImportaveis: SITUACOES_IMPORTAVEIS });
  const vistos = new Map([["702", "2026-10-16T15:30:00Z"], ["703", "2026-10-16T15:30:00Z"], ["704", "2026-10-16T15:30:00Z"]]);
  // sync terminou 16:15 (> vista + 5 min) para 702/704; para 703 só testamos o caso "sync antes da vista" abaixo.
  assertEquals(aplicarCarencia(cls, vistos, "2026-10-16T16:15:00Z").map((p) => `${p.protocolo}:${p.classe}`),
    ["701:carencia_primeira_vista", "702:candidato", "703:candidato", "704:candidato"]);
  // Sync que terminou só 3 min depois da vista (podia ter começado antes dela) não vale.
  assertEquals(aplicarCarencia(cls, vistos, "2026-10-16T15:33:00Z")[1].classe, "carencia_aguarda_sync");
  // Sem sync complete (marcador ausente / último não-complete) ⇒ espera.
  assertEquals(aplicarCarencia(cls, vistos, null)[1].classe, "carencia_aguarda_sync");
  // Quem não é candidato não muda.
  const outro = classificar(lerListaConsulta([linha("100", "1 - Aberto", "15/10/2026")]).pedidos, ctxBase);
  assertEquals(aplicarCarencia(outro, new Map(), null)[0].classe, "ja_no_app");
});

// ── Reconciliação do PO a reconciliar (v1.3) — o caso real é o pedido 3666 / protocolo 2141466 ──
const MARCADOR = { run_id: "run-172", seq: 172, finalizado_em: "2026-10-28T18:17:04Z" };
function pedido(over: Partial<PedidoDisparadoLido> = {}): PedidoDisparadoLido {
  return {
    id: 3666, status: "disparado", canal_usado: "portal_sayerlack", data_ciclo: "2026-10-16",
    portal_protocolo: "2141466", omie_pedido_compra_id: "12199229881",
    omie_po_inexistente_antes_de: "2026-10-16T22:11:14Z", ...over,
  };
}

Deno.test("a reconciliar: PO fora do run válido entra; visto, sem marcador, outro status/canal ou PO ilegível ficam fora", () => {
  assertEquals(pedidosAReconciliar([pedido()], MARCADOR, new Set()).map((p) => p.pedido_id), [3666]);
  assertEquals(pedidosAReconciliar([pedido()], MARCADOR, new Set(["12199229881"])), []);
  assertEquals(pedidosAReconciliar([pedido()], null, new Set()), []);
  assertEquals(pedidosAReconciliar([pedido({ status: "concluido_recebido" })], MARCADOR, new Set()), []);
  assertEquals(pedidosAReconciliar([pedido({ canal_usado: "email" })], MARCADOR, new Set()), []);
  assertEquals(pedidosAReconciliar([pedido({ omie_pedido_compra_id: "PO-1294" })], MARCADOR, new Set()), []);
  assertEquals(pedidosAReconciliar([pedido({ omie_pedido_compra_id: null })], MARCADOR, new Set()), []);
  assertEquals(pedidosAReconciliar([pedido({ portal_protocolo: null })], MARCADOR, new Set()), []);
});

Deno.test("a reconciliar: guard causal — PO criado DEPOIS do run não teve chance de ser visto", () => {
  assertEquals(pedidosAReconciliar([pedido({ omie_po_inexistente_antes_de: "2026-10-28T19:00:00Z" })], MARCADOR, new Set()), []);
  assertEquals(pedidosAReconciliar([pedido({ omie_po_inexistente_antes_de: "lixo" })], MARCADOR, new Set()), []);
  assertEquals(pedidosAReconciliar([pedido({ omie_po_inexistente_antes_de: null })], MARCADOR, new Set()).length, 1);
});

Deno.test("janela: estende até 1 dia antes do ciclo mais antigo; além do teto de 30 dias fica fora do alcance", () => {
  const [a] = pedidosAReconciliar([pedido()], MARCADOR, new Set());
  const j = janelaDeLeitura("2026-10-28", [a]);
  assertEquals(j.emissaoDesde, "2026-10-15");
  assertEquals(j.alcancaveis.length, 1);
  assertEquals(janelaDeLeitura("2026-10-28", []).emissaoDesde, inicioDaJanela("2026-10-28"));
  const velho = { ...a, data_ciclo: "2026-09-20" };
  const jv = janelaDeLeitura("2026-10-28", [velho]);
  assertEquals([jv.emissaoDesde, jv.alcancaveis.length, jv.foraDoAlcance.length], [inicioDaJanela("2026-10-28"), 0, 1]);
});

Deno.test("desfecho: só situação 6 EXATA num protocolo único encerra; o resto só relata", () => {
  const [a] = pedidosAReconciliar([pedido()], MARCADOR, new Set());
  const listado = (situacao: string, codigo: string | null) => ({ protocolo: "2141466", situacao, situacao_codigo: codigo, emissao: "2026-10-16" });
  const classe = (pedidos: ReturnType<typeof listado>[], repetidos: string[] = []) => desfechoNoPortal([a], { pedidos, repetidos })[0].classe;
  assertEquals(classe([listado("6 - Cancelado", "6")]), "cancelado_no_portal");
  assertEquals(classe([listado("1 - Aberto", "1")]), "vivo_ou_outro");
  assertEquals(classe([listado("3 - Atendido Total", "3")]), "vivo_ou_outro");
  // texto "Cancelado" sem o código fechado NÃO encerra (situação renomeada/ilegível não decide).
  assertEquals(classe([listado("Cancelado", null)]), "vivo_ou_outro");
  assertEquals(classe([]), "nao_encontrado");
  assertEquals(classe([listado("6 - Cancelado", "6")], ["2141466"]), "protocolo_repetido");
  assertEquals(classe([listado("6 - Cancelado", "6"), listado("1 - Aberto", "1")]), "protocolo_repetido");
});

Deno.test("identidade do PO: forma canônica de bigint (zeros à esquerda caem), fora da faixa segura = ilegível", () => {
  assertEquals(idDoPo("00101"), "101");
  assertEquals(idDoPo(12199229881), "12199229881");
  assertEquals(idDoPo("9007199254740993"), null); // > MAX_SAFE_INTEGER: o number do PostgREST já viria arredondado
  assertEquals(idDoPo("0"), null);
  assertEquals(idDoPo(" 12 "), "12");
  // Visto como "101" no run ⇒ o pedido com "00101" está PRESENTE (Codex P1: antes entrava como ausente).
  assertEquals(pedidosAReconciliar([pedido({ omie_pedido_compra_id: "00101" })], MARCADOR, new Set(["101"])), []);
});

Deno.test("marcador: só autoriza encerrar até 26 h do fim do run válido", () => {
  const fim = Date.parse(MARCADOR.finalizado_em);
  assertEquals(marcadorFresco(MARCADOR, fim + 26 * 3600_000), true);
  assertEquals(marcadorFresco(MARCADOR, fim + 26 * 3600_000 + 1), false);
  assertEquals(marcadorFresco({ ...MARCADOR, finalizado_em: "lixo" }, fim), false);
});

// ── Onda 3 (2026-11-07): rodada nunca verde sem prova ──
const HEADERS = ["Pedido", "Pedido Cliente", "Situação", "Data Emissão", "Vlr Mercadoria", "Vlr Total"];
const base = { headers: HEADERS, ilegiveis: 0, repetidos: [] as string[] };

Deno.test("prova: 0 linhas SEM total anunciado é erro (incidente 23/10 e 03/11: 0 lidos e sucesso)", () => {
  const r = provarLeitura({ ...base, linhasLidas: 0 });
  assertEquals(r.ok ? "ok" : r.motivo, "zero_lidos_sem_prova");
});
Deno.test("prova: 0 linhas COM o portal dizendo 0 de 0 é sucesso", () => {
  assertEquals(provarLeitura({ ...base, linhasLidas: 0, respostaTotal: 0 }), { ok: true, total: 0 });
  assertEquals(provarLeitura({ ...base, linhasLidas: 0, info: "Mostrando 0 até 0 de 0 registros" }), { ok: true, total: 0 });
});
Deno.test("prova: lidos tem de ser o total anunciado (página perdida ⇒ erro)", () => {
  const r = provarLeitura({ ...base, linhasLidas: 10, respostaTotal: 23 });
  assertEquals(r.ok ? "ok" : r.motivo, "lidos_diferente_do_total");
  assertEquals(provarLeitura({ ...base, linhasLidas: 23, respostaTotal: "23" }), { ok: true, total: 23 });
});
Deno.test("prova: com linhas e sem total também é erro (não prova lista inteira)", () => {
  const r = provarLeitura({ ...base, linhasLidas: 22 });
  assertEquals(r.ok ? "ok" : r.motivo, "total_nao_anunciado");
});
Deno.test("prova: coluna obrigatória ausente (DOM mudou) é erro antes de tudo", () => {
  const r = provarLeitura({ ...base, headers: ["Pedido Cliente", "Situação", "Data Emissão", "Vlr Total"], linhasLidas: 3, respostaTotal: 3 });
  assertEquals(r.ok ? "ok" : r.motivo, "colunas_ausentes");
  // "Pedido Cliente" NÃO conta como "Pedido" (exato).
  assertEquals(!r.ok && r.detalhe.startsWith("colunas ausentes na consulta: Pedido"), true);
});
Deno.test("prova: linha ilegível e protocolo repetido são erro, não descarte silencioso", () => {
  const a = provarLeitura({ ...base, linhasLidas: 3, respostaTotal: 3, ilegiveis: 1 });
  assertEquals(a.ok ? "ok" : a.motivo, "linhas_ilegiveis");
  const b = provarLeitura({ ...base, linhasLidas: 3, respostaTotal: 3, repetidos: ["2140603"] });
  assertEquals(b.ok ? "ok" : b.motivo, "protocolo_repetido");
});
Deno.test("total anunciado: JSON do DataTables vence; texto pt/en; lixo é null", () => {
  assertEquals(totalAnunciado({ respostaTotal: 7, info: "de 7 registros" }), 7);
  assertEquals(totalAnunciado({ info: "Mostrando de 1 até 10 de 1.234 registros" }), 1234);
  assertEquals(totalAnunciado({ info: "Showing 1 to 10 of 23 entries" }), 23);
  assertEquals(totalAnunciado({ respostaTotal: -1 }), null);
  assertEquals(totalAnunciado({ respostaTotal: 2.5 }), null);
  assertEquals(totalAnunciado({ info: "Processando..." }), null);
  assertEquals(totalAnunciado({}), null);
});
Deno.test("carência presa: só aguarda_sync com 1ª vista há mais de 6 h", () => {
  const agora = Date.parse("2026-11-07T12:00:00Z");
  const cl = [
    { protocolo: "1", classe: "carencia_aguarda_sync" },
    { protocolo: "2", classe: "carencia_aguarda_sync" },
    { protocolo: "3", classe: "candidato" },
  ] as unknown as PedidoClassificado[];
  const vistos = new Map([["1", "2026-11-07T05:00:00Z"], ["2", "2026-11-07T07:00:00Z"], ["3", "2026-11-01T00:00:00Z"]]);
  assertEquals(carenciaTravada(cl, vistos, agora).map((t) => t.protocolo), ["1"]);
});
Deno.test("reconsultas além da janela: tentativa mais antiga primeiro (nunca tentado na frente); sem os já lidos; teto", () => {
  const r = reconsultasForaDaJanela({
    lidos: new Set(["111"]),
    semPoNoApp: [{ protocolo: "111", pedido_id: 1 }, { protocolo: "222", pedido_id: 2, ultima_tentativa: "2026-11-05T00:00:00Z" }, { protocolo: "555", pedido_id: 5 }],
    falhasAbertas: [{ protocolo: "444", ultima_em: "2026-11-01T00:00:00Z" }, { protocolo: "333", ultima_em: "2026-11-06T00:00:00Z" }, { protocolo: "222", ultima_em: "2026-10-01" }, { protocolo: "x", ultima_em: "2026-01-01" }],
    teto: 3,
  });
  assertEquals(r.map((q) => q.protocolo + ":" + q.origem), ["555:app_sem_po", "444:falha_aberta", "222:app_sem_po"]);
  assertEquals(reconsultasForaDaJanela({ lidos: new Set(), semPoNoApp: [], falhasAbertas: [] }), []);
});
Deno.test("reconsultas: 13 pendências persistentes — com a tentativa gravada, a 13ª entra em ≤ 4 rodadas (Codex P2)", () => {
  let falhas = Array.from({ length: 13 }, (_, i) => ({ protocolo: String(9000000 + i), ultima_em: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00Z` }));
  const tentados = new Set<string>();
  for (let rodada = 0; rodada < 4; rodada++) {
    const fila = reconsultasForaDaJanela({ lidos: new Set(), semPoNoApp: [], falhasAbertas: falhas });
    for (const q of fila) tentados.add(q.protocolo);
    falhas = falhas.map((f) => fila.some((q) => q.protocolo === f.protocolo) ? { ...f, ultima_em: `2026-11-0${rodada + 1}T00:00:00Z` } : f);
  }
  assertEquals(tentados.size, 13);
});
Deno.test("total: recordsFiltered + DataTables + texto; divergência é explícita", () => {
  assertEquals(totalAnunciado({ respostaTotal: 7, dtTotal: 7, info: "de 7 registros" }), 7);
  assertEquals(totalAnunciado({ dtTotal: 5 }), 5);
  assertEquals(totalAnunciado({ respostaTotal: 7, dtTotal: 9 }), "divergente");
  const r = provarLeitura({ ...base, linhasLidas: 7, respostaTotal: 7, dtTotal: 9 });
  assertEquals(r.ok ? "ok" : r.motivo, "total_divergente");
});
