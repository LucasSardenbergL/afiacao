// Sem rede (`--no-remote` do test:edges): assert inline, como os demais _test.ts desta edge.
import { exigirRazaoFiscal } from "./razao-fiscal.ts";

function lancaComMarca(fn: () => void, marca: string) {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error && e.message.startsWith(marca)) return;
    throw new Error(`lançou outra coisa: ${String(e)}`);
  }
  throw new Error(`não lançou (esperado ${marca})`);
}

Deno.test("razão de MEI mascarada (a forma que o Radar guarda) é recusada", () => {
  lancaComMarca(() => exigirRazaoFiscal("PEDRO ALVES COSTA ***456789**"), "RAZAO_MASCARADA:");
  lancaComMarca(() => exigirRazaoFiscal("PEDRO ALVES COSTA ***456789**  "), "RAZAO_MASCARADA:");
});

Deno.test("razão fiscal de verdade passa: MEI com o CPF, empresa comum, vazia (a obrigatoriedade é de outra guarda)", () => {
  exigirRazaoFiscal("PEDRO ALVES COSTA 12345678901");
  exigirRazaoFiscal("A1 NOVA LTDA");
  exigirRazaoFiscal("ASTERISCO *** COMERCIO LTDA");
  exigirRazaoFiscal(undefined);
});
