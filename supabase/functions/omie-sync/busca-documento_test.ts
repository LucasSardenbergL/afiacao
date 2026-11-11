// Sem rede (`--no-remote` do test:edges): assert inline.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperado ${String(b)}, veio ${String(a)}`);
}
import { buscaPorDocumentoNaoAchou, lerComRetentativa, primeiroClientePorDocumento } from "./busca-documento.ts";

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

Deno.test("lerComRetentativa: a chamada simultânea recusada pelo Omie é retentada e a 2ª devolve", async () => {
  let chamadas = 0;
  const esperas: number[] = [];
  const r = await lerComRetentativa(async () => {
    chamadas++;
    if (chamadas === 1) throw new Error("Erro Omie: Já existe uma requisição desse método em execução");
    return "PEDRO ALVES COSTA 12345678901";
  }, { esperar: async (ms) => { esperas.push(ms); } });
  assertEquals(r, "PEDRO ALVES COSTA 12345678901");
  assertEquals(chamadas, 2);
  assertEquals(esperas.length, 1);
});

Deno.test("lerComRetentativa: permanente sobe na 1ª, sem retentar", async () => {
  let chamadas = 0;
  let marca = "";
  try {
    await lerComRetentativa(async () => {
      chamadas++;
      throw new Error("OMIE_LOOKUP_DIVERGENTE: o ListarClientes da outra conta devolveu um cliente com OUTRO documento");
    }, { esperar: async () => {} });
  } catch (e) {
    marca = e instanceof Error ? e.message.split(":")[0] : "";
  }
  assertEquals(marca, "OMIE_LOOKUP_DIVERGENTE");
  assertEquals(chamadas, 1);
});

Deno.test("lerComRetentativa: concorrência que não passa sobe com a mensagem da última tentativa, no teto", async () => {
  let chamadas = 0;
  let mensagem = "";
  try {
    await lerComRetentativa(async () => {
      chamadas++;
      throw new Error(`Erro Omie: Consumo redundante detectado #${chamadas}`);
    }, { tentativas: 3, esperar: async () => {} });
  } catch (e) {
    mensagem = e instanceof Error ? e.message : "";
  }
  assertEquals(mensagem, "Erro Omie: Consumo redundante detectado #3");
  assertEquals(chamadas, 3);
});

Deno.test("lerComRetentativa: timeout e 5xx sobem na 1ª (cada chamada já gastou o relógio de 140s)", async () => {
  for (const msg of [
    "OMIE_TRANSIENT (oben): timeout — ListarClientes sem resposta em 140s",
    "Erro Omie: HTTP 503 em ListarClientes",
  ]) {
    let chamadas = 0;
    let mensagem = "";
    try {
      await lerComRetentativa(async () => { chamadas++; throw new Error(msg); }, { esperar: async () => {} });
    } catch (e) {
      mensagem = e instanceof Error ? e.message : "";
    }
    assertEquals(mensagem, msg);
    assertEquals(chamadas, 1, `retentou: ${msg}`);
  }
});
