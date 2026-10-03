// Testa o CÓDIGO REAL de listagem.ts no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-nfe-recebimento-sync/listagem_test.ts
//
// O incidente (2026-10-01): a Oben teve 70 recebimentos no Omie desde 14/08 e a sync importou zero.
// A NF-e que o time já tinha recebido direto no Omie, no topo da listagem, gastava a única consulta
// de detalhe de toda rodada. Os casos que importam: a triagem pula recebida/cancelada/sem chave
// ANTES da consulta, e a falha que o Omie devolve com HTTP 200 deixa de passar por listagem vazia.
import {
  contagemVazia,
  falhaNoCorpo,
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

function registro(id: number | string, info?: { cRecebido?: string; cCancelada?: string }, chave: string | null = CHAVE): RegistroListagem {
  return { cabec: { nIdReceb: id, cChaveNFe: chave }, ...(info ? { infoCadastro: info } : {}) };
}

/** A decisão do laço do cron: para quem vai a consulta de detalhe da rodada. */
function primeiraConsulta(registros: RegistroListagem[], jaImportados: Set<number>): number | null {
  for (const r of registros) {
    const t = triarRegistro(r, jaImportados);
    if (t.tipo === "consultar") return t.nIdReceb;
  }
  return null;
}

Deno.test("o incidente: a recebida no Omie no topo não gasta a consulta — ela vai para a pendente de trás", () => {
  const listagem = [
    registro(101, { cRecebido: "S", cCancelada: "N" }),
    registro(102, { cRecebido: "N", cCancelada: "S" }),
    registro(103, { cRecebido: "N", cCancelada: "N" }, null),
    registro(104, { cRecebido: "N", cCancelada: "N" }),
  ];
  assertEquals(primeiraConsulta(listagem, new Set()), 104);
});

Deno.test("paramsListagem: pede infoCadastro e ordem estável — o que a leitura que enxerga a Oben pede", () => {
  const p = paramsListagem(2, "01/09/2026");
  assertEquals(p.cExibirDetalhes, "S");
  assertEquals(p.cOrdenarPor, "CODIGO");
  assertEquals(p.nPagina, 2);
  assertEquals(p.dtEmissaoDe, "01/09/2026");
});

Deno.test("triarRegistro: cada motivo de pulo, com a listagem trazendo infoCadastro", () => {
  const ja = new Set([500]);
  assertEquals(triarRegistro(registro("500", { cRecebido: "N" }), ja), { tipo: "pular", motivo: "ja_importado" }, "id em string casa o Set numérico");
  assertEquals(triarRegistro(registro(501, { cRecebido: " s " }), ja), { tipo: "pular", motivo: "recebido_no_omie" }, "caixa e espaço");
  assertEquals(triarRegistro(registro(502, { cCancelada: "S" }), ja), { tipo: "pular", motivo: "cancelado" });
  assertEquals(triarRegistro(registro(503, { cRecebido: "N" }, "123"), ja), { tipo: "pular", motivo: "sem_chave" });
  assertEquals(triarRegistro(registro(504, { cRecebido: "N" }, null), ja), { tipo: "pular", motivo: "sem_chave" });
  assertEquals(triarRegistro(registro("abc", { cRecebido: "N" }), ja), { tipo: "pular", motivo: "sem_id" });
  assertEquals(triarRegistro({ infoCadastro: { cRecebido: "N" } }, ja), { tipo: "pular", motivo: "sem_id" });
});

Deno.test("triarRegistro: já importada vence 'recebida no Omie' — a NF-e do app conferida e depois recebida", () => {
  assertEquals(triarRegistro(registro(600, { cRecebido: "S" }), new Set([600])), { tipo: "pular", motivo: "ja_importado" });
});

Deno.test("triarRegistro: pendente com chave vai à consulta, com o id numérico", () => {
  assertEquals(
    triarRegistro(registro("700", { cRecebido: "N", cCancelada: "N" }), new Set()),
    { tipo: "consultar", nIdReceb: 700, listagemMagra: false },
  );
  assertEquals(
    triarRegistro({ cabec: { nIdReceb: 701, cChaveNfe: CHAVE }, infoCadastro: {} }, new Set()),
    { tipo: "consultar", nIdReceb: 701, listagemMagra: false },
    "a chave também vem como cChaveNfe",
  );
});

Deno.test("triarRegistro: listagem magra (sem infoCadastro) não decide — o detalhe confere, como antes", () => {
  assertEquals(triarRegistro(registro(800, undefined, null), new Set()), { tipo: "consultar", nIdReceb: 800, listagemMagra: true });
  assertEquals(triarRegistro({ nIdReceb: 801 }, new Set()), { tipo: "consultar", nIdReceb: 801, listagemMagra: true }, "id fora do cabec");
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

Deno.test("interpretarPaginaListagem: 'não existem registros' com HTTP 200 é fim, não falha", () => {
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
  registrarPulo(c, "sem_chave");
  registrarPulo(c, "sem_id");
  assertEquals(
    [c.ja_importados, c.recebidos_no_omie, c.cancelados, c.sem_chave, c.sem_id, c.consultados, c.importados],
    [1, 2, 1, 1, 1, 0, 0],
  );
});
