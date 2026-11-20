// Testa a lógica PURA do e-mail ao CRS. Rodar: deno test --no-remote supabase/functions/email-crs-ajuste-lote/
import {
  assuntoResposta,
  base64Url,
  classificarEnvioGmail,
  extrairMessageIdRfc,
  montarCorpoCobranca,
  montarCorpoInicial,
  montarRfc2822,
  segundosRetryAfter,
} from "./logica.ts";

// Asserts LOCAIS de propósito (sem jsr:@std/assert): `deno test --no-remote` roda no `validate` do CI.
function igual(atual: unknown, esperado: unknown, msg: string) {
  if (atual !== esperado) throw new Error(`${msg}: esperado ${String(esperado)}, veio ${String(atual)}`);
}
function contem(texto: string, trecho: string, msg: string) {
  if (!texto.includes(trecho)) throw new Error(`${msg}: não contém [${trecho}] em [${texto}]`);
}
function lancaCom(fn: () => unknown, marca: string, msg: string) {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error && e.message.includes(marca)) return; // casa a MARCA do ramo, não "lançou algo"
    throw new Error(`${msg}: lançou outra coisa: ${String(e)}`);
  }
  throw new Error(`${msg}: não lançou`);
}
function decodificar(b64: string): string {
  const bin = atob(b64.replace(/\r\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const ITEM = { skuPortal: "YO20.1464.00BB", descricao: "VERNIZ PU", qtdeLancada: 20, qtdeNecessaria: 1 };

Deno.test("Re: entra uma vez só", () => {
  const a = "Alteração de quantidade — Pedido Sayerlack 2152582 [AFI-4557]";
  igual(assuntoResposta(a), `Re: ${a}`, "re");
  igual(assuntoResposta(`Re: ${a}`), `Re: ${a}`, "re idempotente");
  igual(assuntoResposta(`RE: ${a}`), `RE: ${a}`, "RE maiúsculo");
});

Deno.test("corpo inicial traz protocolo, SKU, descrição, lançado N e necessário M, e o pedido de cancelamento", () => {
  const c = montarCorpoInicial("2152582", [ITEM]);
  contem(c, "pedido Sayerlack 2152582", "protocolo");
  contem(c, "- YO20.1464.00BB (VERNIZ PU): lançado 20 UN pelo lote mínimo, precisamos de 1 UN", "linha do item");
  contem(c, "confirmem a alteração", "pede confirmação");
  contem(c, "cancelamento desse item", "cancelamento só do item");
});

Deno.test("corpo inicial com 2 itens usa o plural e lista os dois", () => {
  const c = montarCorpoInicial("9", [ITEM, { ...ITEM, skuPortal: "B", descricao: null, qtdeLancada: 10, qtdeNecessaria: 3 }]);
  contem(c, "os itens abaixo", "plural");
  contem(c, "- B: lançado 10 UN pelo lote mínimo, precisamos de 3 UN", "item sem descrição");
  contem(c, "desses itens", "plural cancelamento");
});

Deno.test("corpo inicial recusa lista vazia e quantidade incoerente (nunca e-mail com número fabricado)", () => {
  lancaCom(() => montarCorpoInicial("1", []), "sem itens", "vazio");
  lancaCom(() => montarCorpoInicial("1", [{ ...ITEM, qtdeLancada: 1, qtdeNecessaria: 1 }]), "incoerentes", "lançado = necessário");
  lancaCom(() => montarCorpoInicial("1", [{ ...ITEM, qtdeNecessaria: 0 }]), "incoerentes", "necessário 0");
  lancaCom(() => montarCorpoInicial("1", [{ ...ITEM, qtdeNecessaria: Number.NaN }]), "incoerentes", "NaN");
});

Deno.test("cobrança tem o texto decidido", () => {
  igual(montarCorpoCobranca("2152582"), "Bom dia, conseguem confirmar a alteração do pedido 2152582?", "cobrança");
});

Deno.test("RFC 2822: sem From, assunto RFC 2047, corpo base64 UTF-8; resposta traz In-Reply-To/References", () => {
  const raw = montarRfc2822({ para: "crs@x", assunto: "Alteração", corpo: "lançado ção", messageId: "<m1@a>" });
  contem(raw, "To: crs@x\r\n", "to");
  igual(raw.includes("From:"), false, "sem From");
  igual(raw.includes("In-Reply-To"), false, "1º e-mail sem In-Reply-To");
  contem(raw, "Message-ID: <m1@a>", "message-id");
  const [cab, corpo] = raw.split("\r\n\r\n");
  igual(decodificar(corpo), "lançado ção", "corpo UTF-8 ida e volta");
  const subj = /Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(cab)?.[1] ?? "";
  igual(decodificar(subj), "Alteração", "assunto UTF-8 ida e volta");
  const resp = montarRfc2822({ para: "crs@x", assunto: "Re: A", corpo: "b", messageId: "<m2@a>", inReplyTo: "<m1@a>" });
  contem(resp, "In-Reply-To: <m1@a>\r\nReferences: <m1@a>", "cabeçalhos de resposta");
});

Deno.test("base64Url sem padding nem + /", () => {
  const s = base64Url("ção??>>");
  igual(/[+/=]/.test(s), false, "alfabeto url-safe");
});

Deno.test("classificarEnvioGmail: só 4xx é não-enviado; 5xx, rede e 2xx sem threadId são indeterminados", () => {
  igual(classificarEnvioGmail({ status: 200, corpo: '{"id":"a","threadId":"t"}' }).tipo, "enviado", "200 ok");
  const ok = classificarEnvioGmail({ status: 200, corpo: '{"id":"a","threadId":"t"}' });
  if (ok.tipo !== "enviado" || ok.threadId !== "t" || ok.id !== "a") throw new Error("ids do 200");
  igual(classificarEnvioGmail({ status: 200, corpo: '{"id":"a"}' }).tipo, "indeterminado", "200 sem threadId");
  igual(classificarEnvioGmail({ status: 200, corpo: "lixo" }).tipo, "indeterminado", "200 corpo ilegível");
  igual(classificarEnvioGmail({ status: 400, corpo: "x" }).tipo, "nao_enviado", "400");
  igual(classificarEnvioGmail({ status: 401, corpo: "x" }).tipo, "nao_enviado", "401");
  igual(classificarEnvioGmail({ status: 429, corpo: "x" }).tipo, "nao_enviado", "429");
  igual(classificarEnvioGmail({ status: 500, corpo: "x" }).tipo, "indeterminado", "500");
  igual(classificarEnvioGmail({ status: 503, corpo: "x" }).tipo, "indeterminado", "503");
  igual(classificarEnvioGmail({ erroRede: "timeout" }).tipo, "indeterminado", "rede");
});

Deno.test("segundosRetryAfter: segundos, data HTTP, lixo", () => {
  igual(segundosRetryAfter("120", 0), 120, "segundos");
  igual(segundosRetryAfter(null, 0), null, "ausente");
  igual(segundosRetryAfter("amanhã", 0), null, "lixo");
  igual(segundosRetryAfter("999999", 0), 86400, "teto");
  igual(segundosRetryAfter(new Date(60_000).toUTCString(), 0), 60, "data HTTP");
});

Deno.test("extrairMessageIdRfc lê o cabeçalho sem caixa fixa e recusa forma estranha", () => {
  igual(extrairMessageIdRfc({ payload: { headers: [{ name: "Message-Id", value: " <a@b.c> " }] } }), "<a@b.c>", "ok");
  igual(extrairMessageIdRfc({ payload: { headers: [{ name: "Message-ID", value: "a@b" }] } }), null, "sem <>");
  igual(extrairMessageIdRfc({ payload: {} }), null, "sem headers");
  igual(extrairMessageIdRfc(null), null, "nulo");
});
