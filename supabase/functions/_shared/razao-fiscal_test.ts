// Sem rede (`--no-remote` do test:edges): assert inline.
// As amostras de `razaoSemCpf` são as MESMAS da prova SQL (db/test-clientes-mei-cpf-mascarado.sh, M2): a máscara em TS
// tem de ser o espelho da `private.radar_razao_mascarada`.
import { exigirRazaoFiscal, razaoSemCpf } from "./razao-fiscal.ts";

function igual(obtido: unknown, esperado: unknown) {
  if (obtido !== esperado) throw new Error(`esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(obtido)}`);
}

function lancaComMarca(fn: () => void, marca: string) {
  try {
    fn();
  } catch (e) {
    if (e instanceof Error && e.message.startsWith(marca)) return;
    throw new Error(`lançou outra coisa: ${String(e)}`);
  }
  throw new Error(`não lançou (esperado ${marca})`);
}

Deno.test("razaoSemCpf: as três formas medidas em prod e o CPF com espaço", () => {
  igual(razaoSemCpf("PEDRO ALVES COSTA 12345678901"), "PEDRO ALVES COSTA ***456789**");
  igual(razaoSemCpf("PEDRO ALVES COSTA 123.456.789-01"), "PEDRO ALVES COSTA ***.456.789-**");
  igual(razaoSemCpf("PEDRO 12345678901 ALVES"), "PEDRO ***456789** ALVES");
  igual(razaoSemCpf("PEDRO CPF 123 456 789 01"), "PEDRO CPF *** 456 789 **");
});

Deno.test("razaoSemCpf não toca o que não é CPF: CNPJ, 10 ou 12 dígitos, vazio", () => {
  igual(razaoSemCpf("ACME LTDA 12345678000195"), "ACME LTDA 12345678000195");
  igual(razaoSemCpf("LOJA 1234567890"), "LOJA 1234567890");
  igual(razaoSemCpf("LOJA 123456789012"), "LOJA 123456789012");
  igual(razaoSemCpf("A1 NOVA LTDA"), "A1 NOVA LTDA");
  igual(razaoSemCpf(null), null);
  igual(razaoSemCpf(undefined), undefined);
});

Deno.test("razaoSemCpf é idempotente: mascarar de novo não muda", () => {
  const uma = razaoSemCpf("PEDRO ALVES COSTA 123.456.789-01");
  igual(razaoSemCpf(uma), uma);
});

Deno.test("a razão mascarada é recusada em qualquer forma que a máscara deixa", () => {
  lancaComMarca(() => exigirRazaoFiscal("PEDRO ALVES COSTA ***456789**"), "RAZAO_MASCARADA:");
  lancaComMarca(() => exigirRazaoFiscal("PEDRO ALVES COSTA ***456789**  "), "RAZAO_MASCARADA:");
  lancaComMarca(() => exigirRazaoFiscal("PEDRO ALVES COSTA ***.456.789-**"), "RAZAO_MASCARADA:");
  lancaComMarca(() => exigirRazaoFiscal("PEDRO ***456789** ALVES"), "RAZAO_MASCARADA:");
  lancaComMarca(() => exigirRazaoFiscal("PEDRO CPF *** 456 789 **"), "RAZAO_MASCARADA:");
});

Deno.test("razão fiscal de verdade passa: MEI com o CPF, empresa comum, asterisco solto, vazia", () => {
  exigirRazaoFiscal("PEDRO ALVES COSTA 12345678901");
  exigirRazaoFiscal("PEDRO ALVES COSTA 123.456.789-01");
  exigirRazaoFiscal("A1 NOVA LTDA");
  exigirRazaoFiscal("ASTERISCO *** COMERCIO LTDA");
  exigirRazaoFiscal("***1** LTDA");
  exigirRazaoFiscal(undefined);
});
