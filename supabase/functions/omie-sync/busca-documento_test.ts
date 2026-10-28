// Sem rede (`--no-remote` do test:edges): assert inline.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperado ${String(b)}, veio ${String(a)}`);
}
import { buscaPorDocumentoNaoAchou } from "./busca-documento.ts";

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
