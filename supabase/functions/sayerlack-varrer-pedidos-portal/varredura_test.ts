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
