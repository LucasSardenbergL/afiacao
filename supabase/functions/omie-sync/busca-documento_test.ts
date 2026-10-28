// Sem rede (`--no-remote` do test:edges): assert inline.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperado ${String(b)}, veio ${String(a)}`);
}
import { buscaPorDocumentoNaoAchou, primeiroClientePorDocumento } from "./busca-documento.ts";

Deno.test("só o EOF do Omie é ausência (busca vazia → codigo_cliente null)", () => {
  assertEquals(buscaPorDocumentoNaoAchou(new Error("Erro Omie: ERROR: Não existem registros para a página [1]!")), true);
  assertEquals(buscaPorDocumentoNaoAchou(new Error("Erro Omie: Nao existem registros para a pagina [1]")), true);
});

Deno.test("transitório, permanente e indeterminado NÃO são ausência (falham alto)", () => {
  for (const msg of [
    "Erro Omie: SOAP-ERROR: Broken response from Application Server",
    "Omie HTTP 503 sem faultstring",
    "Erro Omie: Consumo redundante detectado",
    "Erro Omie: Chave de acesso não cadastrada para o aplicativo [redigido]",
    "TypeError: fetch failed",
    "",
  ]) {
    assertEquals(buscaPorDocumentoNaoAchou(new Error(msg)), false, `msg ${JSON.stringify(msg)}`);
  }
  assertEquals(buscaPorDocumentoNaoAchou(undefined), false);
});

/** Mensagem do erro lançado, ou "SEM_ERRO" — o teste casa a MARCA, nunca "lançou algo". */
async function mensagemDoErro(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "SEM_ERRO";
  } catch (e) {
    return (e as Error).message;
  }
}

Deno.test("primeiroClientePorDocumento: EOF e página vazia são ausência; registro volta", async () => {
  const eof = () => Promise.reject(new Error("Erro Omie: ERROR: Não existem registros para a página [1]!"));
  assertEquals(await primeiroClientePorDocumento(eof), undefined);
  assertEquals(await primeiroClientePorDocumento(() => Promise.resolve({ clientes_cadastro: [] })), undefined);
  const r = await primeiroClientePorDocumento<{ codigo_cliente_omie: number }>(() =>
    Promise.resolve({ clientes_cadastro: [{ codigo_cliente_omie: 42 }] })
  );
  assertEquals(r?.codigo_cliente_omie, 42);
});

Deno.test("primeiroClientePorDocumento: resposta malformada LANÇA OMIE_RESPOSTA_MALFORMADA (nunca ausência)", async () => {
  for (const resposta of [{}, { error: "Service unavailable" }, { clientes_cadastro: {} }, null, undefined, "ok"]) {
    const msg = await mensagemDoErro(primeiroClientePorDocumento(() => Promise.resolve(resposta)));
    assertEquals(msg.startsWith("OMIE_RESPOSTA_MALFORMADA:"), true, `resposta ${JSON.stringify(resposta)} → ${msg}`);
  }
});

Deno.test("primeiroClientePorDocumento: erro que não é EOF é relançado intacto", async () => {
  const msg = await mensagemDoErro(
    primeiroClientePorDocumento(() => Promise.reject(new Error("Erro Omie: SOAP-ERROR: Broken response from Application Server"))),
  );
  assertEquals(msg, "Erro Omie: SOAP-ERROR: Broken response from Application Server");
});
