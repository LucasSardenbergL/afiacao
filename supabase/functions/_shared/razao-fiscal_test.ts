// Sem rede (`--no-remote` do test:edges): assert inline.
// As amostras de `razaoSemCpf` são as MESMAS da prova SQL (db/test-clientes-mei-cpf-mascarado.sh, M2): a máscara em TS
// tem de ser o espelho da `private.radar_razao_mascarada`.
import { fantasiaParaExibicao, fontesDaRazaoFiscalVendas, razaoFiscalParaCadastro, razaoParaExibicao, razaoSemCpf } from "./razao-fiscal.ts";

function igual(obtido: unknown, esperado: unknown) {
  if (obtido !== esperado) throw new Error(`esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(obtido)}`);
}

async function rejeitaComMarca(p: Promise<unknown>, marca: string) {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith(marca)) return;
    throw new Error(`rejeitou com outra coisa: ${String(e)}`);
  }
  throw new Error(`não rejeitou (esperado ${marca})`);
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

Deno.test("razão de verdade passa como veio, sem consultar conta: MEI com o CPF, empresa comum, asterisco solto", async () => {
  for (const r of ["PEDRO ALVES COSTA 12345678901", "PEDRO ALVES COSTA 123.456.789-01", "A1 NOVA LTDA",
    "ASTERISCO *** COMERCIO LTDA", "***1** LTDA"]) {
    igual(await razaoFiscalParaCadastro(r, ["oben"], () => Promise.reject(new Error("não devia consultar"))), r);
  }
});

Deno.test("a razão mascarada, em qualquer forma que a máscara deixa, nunca passa sem razão fiscal", async () => {
  for (const r of ["PEDRO ALVES COSTA ***456789**", "PEDRO ALVES COSTA ***456789**  ", "PEDRO ALVES COSTA ***.456.789-**",
    "PEDRO ***456789** ALVES", "PEDRO CPF *** 456 789 **"]) {
    await rejeitaComMarca(razaoFiscalParaCadastro(r, ["oben"], () => Promise.resolve(null)), "RAZAO_MASCARADA:");
  }
});

Deno.test("razaoFiscalParaCadastro: mascarada vira a razão fiscal da 1ª conta que tem o documento", async () => {
  const consultadas: string[] = [];
  const r = await razaoFiscalParaCadastro("PEDRO ALVES COSTA ***456789**", ["oben", "colacor"], (c) => {
    consultadas.push(c);
    return Promise.resolve(c === "colacor" ? " PEDRO ALVES COSTA 12345678901 " : null);
  });
  igual(r, "PEDRO ALVES COSTA 12345678901");
  igual(consultadas.join(","), "oben,colacor");
});

Deno.test("razaoFiscalParaCadastro: a conta só tem a razão mascarada ou vazia, ou não há conta → RAZAO_MASCARADA", async () => {
  await rejeitaComMarca(razaoFiscalParaCadastro("MARIA ***456789**", ["oben"], () => Promise.resolve("MARIA ***456789**")), "RAZAO_MASCARADA:");
  await rejeitaComMarca(razaoFiscalParaCadastro("MARIA ***456789**", ["oben"], () => Promise.resolve("  ")), "RAZAO_MASCARADA:");
  await rejeitaComMarca(razaoFiscalParaCadastro("MARIA ***456789**", [], () => Promise.resolve("MARIA 12345678901")), "RAZAO_MASCARADA:");
});

Deno.test("razaoFiscalParaCadastro: falha de leitura da conta sobe (não vira 'não existe' nem pula para a próxima)", async () => {
  const consultadas: string[] = [];
  await rejeitaComMarca(
    razaoFiscalParaCadastro("MARIA ***456789**", ["oben", "colacor"], (c) => {
      consultadas.push(c);
      return Promise.reject(new Error("OMIE_LOOKUP_INDETERMINADO: resposta inválida"));
    }),
    "OMIE_LOOKUP_INDETERMINADO:",
  );
  igual(consultadas.join(","), "oben");
});

Deno.test("razaoParaExibicao: MEI com o CPF sai mascarado e a razão fiscal fica só no campo do cadastro", () => {
  const r = razaoParaExibicao("PEDRO ALVES COSTA 12345678901");
  igual(r.razao_social, "PEDRO ALVES COSTA ***456789**");
  igual(r.razao_fiscal, "PEDRO ALVES COSTA 12345678901");
  igual(Object.keys(r).length, 2);
});

Deno.test("razaoParaExibicao: razão sem CPF (empresa comum, já mascarada, vazia) não ganha razao_fiscal", () => {
  for (const razao of ["COLACOR COMERCIAL LTDA", "PEDRO ALVES COSTA ***456789**", "", "ACME 12.345.678/0001-90"]) {
    const r = razaoParaExibicao(razao);
    igual(r.razao_social, razao);
    igual("razao_fiscal" in r, false);
  }
});

Deno.test("fantasiaParaExibicao: telefone de 11 dígitos sai mascarado na tela e inteiro no cadastro", () => {
  const r = fantasiaParaExibicao("DISK TINTAS 31999998888");
  igual(r.nome_fantasia, "DISK TINTAS ***999988**");
  igual(r.fantasia_fiscal, "DISK TINTAS 31999998888");
  igual("fantasia_fiscal" in fantasiaParaExibicao("DISK TINTAS"), false);
});

Deno.test("fontesDaRazaoFiscalVendas: a outra conta de vendas e depois a Colacor SC, nunca a que cadastra", () => {
  igual(fontesDaRazaoFiscalVendas("oben").join(","), "colacor,colacor_sc");
  igual(fontesDaRazaoFiscalVendas("colacor").join(","), "oben,colacor_sc");
});

Deno.test("MEI que só a Colacor SC tem: as duas contas de vendas provam ausência e a razão fiscal vem da SC", async () => {
  const consultadas: string[] = [];
  const r = await razaoFiscalParaCadastro("PEDRO ALVES COSTA ***456789**", fontesDaRazaoFiscalVendas("oben"), (c) => {
    consultadas.push(c);
    return Promise.resolve(c === "colacor_sc" ? "PEDRO ALVES COSTA 12345678901" : null);
  });
  igual(r, "PEDRO ALVES COSTA 12345678901");
  igual(consultadas.join(","), "colacor,colacor_sc");
});
