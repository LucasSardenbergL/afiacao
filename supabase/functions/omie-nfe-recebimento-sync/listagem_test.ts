// Testa o CÓDIGO REAL de listagem.ts no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-nfe-recebimento-sync/listagem_test.ts
//
// Os helpers puros da triagem. O laço REAL do cron (quem gasta a consulta, o que grava, o que vai
// para a resposta) está em rodada_test.ts — a revisão do Codex de 2026-10-05 mostrou que testar só
// estes helpers deixava o laço sabotável com tudo verde.
import { estadoNoOmie } from "./estado.ts";
import {
  acrescentarEstacionadas,
  contagemVazia,
  corpoDeFalhaOmie,
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
    triarRegistro({ cabec: { nIdReceb: 701, cChaveNfe: CHAVE }, infoCadastro: { cRecebido: "N", cCancelada: "N" } }, NADA),
    { tipo: "consultar", nIdReceb: 701, incompleta: null },
    "a chave também vem como cChaveNfe",
  );
});

Deno.test("triarRegistro: o que a listagem não diz não é descartado — vai à consulta como INCOMPLETA", () => {
  assertEquals(triarRegistro(registro(800, undefined, null), NADA), { tipo: "consultar", nIdReceb: 800, incompleta: "listagem_magra" });
  assertEquals(triarRegistro({ nIdReceb: 801 }, NADA), { tipo: "consultar", nIdReceb: 801, incompleta: "listagem_magra" }, "id fora do cabec");
  assertEquals(triarRegistro(registro(804, {}), NADA), { tipo: "consultar", nIdReceb: 804, incompleta: "listagem_magra" }, "estado sem os 'N' explícitos");
  // Revisão do Codex (2026-10-05): infoCadastro presente não prova cabeçalho inteiro.
  const aberta = { cRecebido: "N", cCancelada: "N" };
  assertEquals(triarRegistro(registro(802, aberta, null), NADA), { tipo: "consultar", nIdReceb: 802, incompleta: "chave_na_listagem" });
  assertEquals(triarRegistro(registro(803, aberta, "123"), NADA), { tipo: "consultar", nIdReceb: 803, incompleta: "chave_na_listagem" });
});

Deno.test("estadoNoOmie: cancelada vence recebida; aberta só com os dois 'N' explícitos — o resto é desconhecido", () => {
  assertEquals(estadoNoOmie({ cCancelada: "S", cRecebido: "S" }), "cancelado");
  assertEquals(estadoNoOmie({ cRecebido: " s " }), "recebido_no_omie");
  assertEquals(estadoNoOmie({ cRecebido: "N", cCancelada: "N" }), "aberta");
  assertEquals(estadoNoOmie({ cRecebido: " n ", cCancelada: "n" }), "aberta", "caixa e espaço");
  assertEquals(estadoNoOmie({ cRecebido: "N" }), "desconhecido", "sem cCancelada");
  assertEquals(estadoNoOmie({}), "desconhecido");
  assertEquals(estadoNoOmie(undefined), "desconhecido");
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

// ── CT-e (modelo 57) fora da fila (2026-10-20) ──────────────────────────────────────────────────
// O `ListarRecebimentos` mistura NF-e e CT-e (frete, SEM itens). Medido em prod: 28 cabeçalhos
// CT-e gravados sem itens, e a única consulta da rodada 12:50Z gasta numa CT-e → NFE01 "lote sem itens".
const CHAVE_CTE = CHAVE.slice(0, 20) + "57" + CHAVE.slice(22);
const PENDENTE_L = { cRecebido: "N", cCancelada: "N" };
/** `cModeloNFe: null` = o campo não veio na listagem (undefined cairia no default). */
function cte(id: number, chave: string | null = CHAVE_CTE, cModeloNFe: string | null = "57"): RegistroListagem {
  return { cabec: { nIdReceb: id, cChaveNFe: chave, cModeloNFe }, infoCadastro: PENDENTE_L };
}

Deno.test("triarRegistro: CT-e (chave E cModeloNFe 57) é pulo 'cte' — nunca candidata, mesmo pendente e inédita", () => {
  assertEquals(triarRegistro(cte(2001), NADA), { tipo: "pular", motivo: "cte" });
});

Deno.test("triarRegistro: 'cte' vence 'ja_importado' — os 26 CT-e efetivados contam como CT-e, não como já importadas", () => {
  const ja = { ids: new Set([2002]), chaves: new Set([CHAVE_CTE]) };
  assertEquals(triarRegistro(cte(2002), ja), { tipo: "pular", motivo: "cte" }, "pelo id");
  assertEquals(triarRegistro(cte(2003), ja), { tipo: "pular", motivo: "cte" }, "pela chave");
  assertEquals(triarRegistro(cte(-1), NADA), { tipo: "pular", motivo: "cte" }, "até sem id utilizável é CT-e, não sem_id");
});

Deno.test("triarRegistro: NF-e (55) com cModeloNFe segue o fluxo de hoje; CT-e só pela chave (sem cModeloNFe) NÃO é excluída — incerteza vira consulta", () => {
  assertEquals(triarRegistro({ cabec: { nIdReceb: 2004, cChaveNFe: CHAVE, cModeloNFe: "55" }, infoCadastro: PENDENTE_L }, NADA), { tipo: "consultar", nIdReceb: 2004, incompleta: null });
  assertEquals(triarRegistro(cte(2005, CHAVE_CTE, null), NADA), { tipo: "consultar", nIdReceb: 2005, incompleta: null }, "contrato do helper: denylist com os DOIS sinais");
  assertEquals(triarRegistro(cte(2006, CHAVE, "57"), NADA), { tipo: "consultar", nIdReceb: 2006, incompleta: null }, "divergente (chave 55, cabeçalho 57) segue o fluxo");
  assertEquals(triarRegistro(cte(2007, CHAVE_CTE, "55"), NADA), { tipo: "consultar", nIdReceb: 2007, incompleta: null }, "divergente (chave 57, cabeçalho 55) segue o fluxo");
  assertEquals(triarRegistro(cte(2008, CHAVE_CTE.slice(1), "57"), NADA), { tipo: "consultar", nIdReceb: 2008, incompleta: "chave_na_listagem" }, "chave de 43 dígitos é ilegível: não prova CT-e, vai à consulta");
  assertEquals(triarRegistro(cte(2009, CHAVE_CTE, "5 7"), NADA), { tipo: "consultar", nIdReceb: 2009, incompleta: null }, "modelo malformado não é evidência");
});

Deno.test("registrarPulo('cte') cai em `ctes` — o denominador do sensor do cron", () => {
  const c = contagemVazia();
  registrarPulo(c, "cte");
  registrarPulo(c, "cte");
  assertEquals([c.ctes, c.ja_importados, c.sem_id], [2, 0, 0]);
});

Deno.test("acrescentarEstacionadas: a chave vale para qualquer conta; o id SÓ na conta que o registrou", () => {
  // Parecer adversarial do Codex (2026-10-20): CT-e estacionada em OB com id 101 fazia a NF-e 55 de CC
  // com o mesmo id 101 virar "já importada" — a leitura do ledger por chave não filtra armazém.
  const ids = new Set<number>();
  const chaves = new Set<string>();
  acrescentarEstacionadas(
    [
      { chave_acesso: CHAVE_CTE, omie_id_receb: 101, warehouse_id: "wh-ob" },
      { chave_acesso: CHAVE, omie_id_receb: "202", warehouse_id: "wh-cc" },
      { chave_acesso: CHAVE.replace(/^31/, "35"), omie_id_receb: 303, warehouse_id: null },
    ],
    "wh-cc",
    ids,
    chaves,
  );
  assertEquals([[...ids], [...chaves].length], [[202], 3]);
  assertEquals(triarRegistro(registro(101, { cRecebido: "N", cCancelada: "N" }, CHAVE.replace(/^31/, "41")), { ids, chaves }), { tipo: "consultar", nIdReceb: 101, incompleta: null }, "a NF-e de CC com o id da CT-e de OB segue candidata");
});
