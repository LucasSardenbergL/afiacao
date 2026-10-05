// Testa o CÓDIGO REAL de listagem.ts no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-nfe-recebimento-sync/listagem_test.ts
//
// Os helpers puros da triagem. O laço REAL do cron (quem gasta a consulta, o que grava, o que vai
// para a resposta) está em rodada_test.ts — a revisão do Codex de 2026-10-05 mostrou que testar só
// estes helpers deixava o laço sabotável com tudo verde.
import {
  contagemVazia,
  corpoDeFalhaOmie,
  estadoNoOmie,
  falhaNoCorpo,
  identidadeDoRegistro,
  interpretarPaginaListagem,
  paramsListagem,
  type RegistroListagem,
  registrarPulo,
  triarRegistro,
} from "./listagem.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const CHAVE = "31260912345678000190550010000123451000123456";
const NADA = { ids: new Set<number>(), chaves: new Set<string>() };

function registro(id: number | string, info?: { cRecebido?: string; cCancelada?: string }, chave: string | null = CHAVE): RegistroListagem {
  return { cabec: { nIdReceb: id, cChaveNFe: chave }, ...(info ? { infoCadastro: info } : {}) };
}

Deno.test("paramsListagem: pede infoCadastro e ordem estável — o que a leitura que enxerga a Oben pede", () => {
  const p = paramsListagem(2, "01/09/2026");
  assertEquals(p.cExibirDetalhes, "S");
  assertEquals(p.cOrdenarPor, "CODIGO");
  assertEquals(p.nPagina, 2);
  assertEquals(p.dtEmissaoDe, "01/09/2026");
});

Deno.test("triarRegistro: só pula com evidência da listagem — já importada (id ou chave), cancelada, recebida, sem id", () => {
  const ja = { ids: new Set([500]), chaves: new Set([CHAVE.replace(/^31/, "35")]) };
  assertEquals(triarRegistro(registro("500", { cRecebido: "N" }), ja), { tipo: "pular", motivo: "ja_importado" }, "id em string casa o Set numérico");
  assertEquals(triarRegistro(registro(510, { cRecebido: "N" }, CHAVE.replace(/^31/, "35")), ja), { tipo: "pular", motivo: "ja_importado" }, "pela chave");
  assertEquals(triarRegistro(registro(501, { cRecebido: " s " }), ja), { tipo: "pular", motivo: "recebido_no_omie" }, "caixa e espaço");
  assertEquals(triarRegistro(registro(502, { cCancelada: "S" }), ja), { tipo: "pular", motivo: "cancelado" });
  assertEquals(triarRegistro(registro("abc", { cRecebido: "N" }), ja), { tipo: "pular", motivo: "sem_id" });
  assertEquals(triarRegistro({ infoCadastro: { cRecebido: "N" } }, ja), { tipo: "pular", motivo: "sem_id" });
});

Deno.test("triarRegistro: já importada vence 'recebida no Omie' — a NF-e do app conferida e depois recebida", () => {
  assertEquals(triarRegistro(registro(600, { cRecebido: "S" }), { ids: new Set([600]), chaves: new Set() }), { tipo: "pular", motivo: "ja_importado" });
});

Deno.test("triarRegistro: pendente com chave vai à consulta como COMPLETA, com o id numérico", () => {
  assertEquals(triarRegistro(registro("700", { cRecebido: "N", cCancelada: "N" }), NADA), { tipo: "consultar", nIdReceb: 700, incompleta: null });
  assertEquals(
    triarRegistro({ cabec: { nIdReceb: 701, cChaveNfe: CHAVE }, infoCadastro: {} }, NADA),
    { tipo: "consultar", nIdReceb: 701, incompleta: null },
    "a chave também vem como cChaveNfe",
  );
});

Deno.test("triarRegistro: o que a listagem não diz não é descartado — vai à consulta como INCOMPLETA", () => {
  assertEquals(triarRegistro(registro(800, undefined, null), NADA), { tipo: "consultar", nIdReceb: 800, incompleta: "listagem_magra" });
  assertEquals(triarRegistro({ nIdReceb: 801 }, NADA), { tipo: "consultar", nIdReceb: 801, incompleta: "listagem_magra" }, "id fora do cabec");
  // Revisão do Codex (2026-10-05): infoCadastro presente não prova cabeçalho inteiro.
  assertEquals(triarRegistro(registro(802, { cRecebido: "N" }, null), NADA), { tipo: "consultar", nIdReceb: 802, incompleta: "chave_na_listagem" });
  assertEquals(triarRegistro(registro(803, { cRecebido: "N" }, "123"), NADA), { tipo: "consultar", nIdReceb: 803, incompleta: "chave_na_listagem" });
});

Deno.test("estadoNoOmie: o mesmo critério para listagem e detalhe — cancelada vence recebida", () => {
  assertEquals(estadoNoOmie({ cCancelada: "S", cRecebido: "S" }), "cancelado");
  assertEquals(estadoNoOmie({ cRecebido: " s " }), "recebido_no_omie");
  assertEquals(estadoNoOmie({ cRecebido: "N", cCancelada: "N" }), null);
  assertEquals(estadoNoOmie(undefined), null);
});

Deno.test("identidadeDoRegistro: id do cabec ou do registro; chave normalizada ou null", () => {
  assertEquals(identidadeDoRegistro({ nIdReceb: "42" }), { id: 42, chave: null });
  assertEquals(identidadeDoRegistro(registro(43, {}, CHAVE.replace(/(\d{4})/g, "$1 ").trim())), { id: 43, chave: CHAVE });
  assertEquals(identidadeDoRegistro(registro(-1)), { id: null, chave: CHAVE });
});

Deno.test("interpretarPaginaListagem: registros e total declarado", () => {
  const p = interpretarPaginaListagem({ nTotalPaginas: 2, recebimentos: [registro(1), registro(2)] });
  assertEquals(p.tipo, "registros");
  if (p.tipo === "registros") {
    assertEquals(p.registros.length, 2);
    assertEquals(p.totalPaginas, 2);
  }
  assertEquals(interpretarPaginaListagem({}), { tipo: "registros", registros: [], totalPaginas: undefined });
});

Deno.test("interpretarPaginaListagem: 'não existem registros' é fim, não falha", () => {
  assertEquals(interpretarPaginaListagem({ faultstring: "ERROR: Não existem registros para a página [1]!" }), { tipo: "fim" });
});

Deno.test("interpretarPaginaListagem: outra faultstring é falha — e sai sem a app_key", () => {
  const redundante = interpretarPaginaListagem({ faultstring: "Consumo redundante detectado. Aguarde 30 segundos (REDUNDANT)" });
  assertEquals(redundante.tipo, "falha");
  if (redundante.tipo === "falha") assertEquals(redundante.mensagem.includes("REDUNDANT"), true);

  const credencial = interpretarPaginaListagem({ faultstring: "Chave de acesso não cadastrada para o aplicativo [1503123456789]" });
  assertEquals(credencial.tipo, "falha");
  if (credencial.tipo === "falha") assertEquals(credencial.mensagem.includes("1503123456789"), false, "a app_key vazou");

  assertEquals(interpretarPaginaListagem(null).tipo, "falha");
  assertEquals(interpretarPaginaListagem([registro(1)]).tipo, "falha");
});

Deno.test("corpo só com faultcode também é falha — não lista vazia nem detalhe sem chave", () => {
  assertEquals(interpretarPaginaListagem({ faultcode: "SOAP-ENV:Server" }).tipo, "falha");
  assertEquals(falhaNoCorpo({ faultcode: "SOAP-ENV:Server" }), "SOAP-ENV:Server");
  assertEquals(corpoDeFalhaOmie('{"faultcode":"SOAP-ENV:Server"}') !== null, true);
});

Deno.test("corpoDeFalhaOmie: o HTTP 500 REAL do CC (2026-10-05) volta como corpo — e a listagem o lê como fim", () => {
  const real = '{"faultstring":"ERROR: N\\u00e3o existem registros para a p\\u00e1gina [1]!","faultcode":"SOAP-ENV:Client-5113"}';
  const corpo = corpoDeFalhaOmie(real);
  assertEquals(corpo !== null, true, "o corpo de falha do Omie foi descartado");
  assertEquals(interpretarPaginaListagem(corpo), { tipo: "fim" });
});

Deno.test("corpoDeFalhaOmie: o que não é corpo de falha do Omie fica null (falha de transporte)", () => {
  assertEquals(corpoDeFalhaOmie("<html>502 Bad Gateway</html>"), null);
  assertEquals(corpoDeFalhaOmie('{"recebimentos":[]}'), null);
  assertEquals(corpoDeFalhaOmie('[{"faultstring":"x"}]'), null);
  assertEquals(corpoDeFalhaOmie(""), null);
});

Deno.test("falhaNoCorpo: detalhe com cabec passa; faultstring vira mensagem redigida", () => {
  assertEquals(falhaNoCorpo({ cabec: { cChaveNFe: CHAVE } }), null);
  assertEquals(falhaNoCorpo({ faultstring: "Recebimento não encontrado" }), "Recebimento não encontrado");
  assertEquals((falhaNoCorpo({ faultstring: "aplicativo [1503123456789] inválido" }) ?? "").includes("1503123456789"), false);
  assertEquals(typeof falhaNoCorpo("<html>"), "string");
});

Deno.test("registrarPulo: cada motivo cai no seu contador", () => {
  const c = contagemVazia();
  registrarPulo(c, "ja_importado");
  registrarPulo(c, "recebido_no_omie");
  registrarPulo(c, "recebido_no_omie");
  registrarPulo(c, "cancelado");
  registrarPulo(c, "sem_id");
  assertEquals([c.ja_importados, c.recebidos_no_omie, c.cancelados, c.sem_id, c.consultados, c.importados], [1, 2, 1, 1, 0, 0]);
});
