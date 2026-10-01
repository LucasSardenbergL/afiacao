// Testa o CÓDIGO REAL de cabecalho.ts no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-nfe-recebimento-sync/cabecalho_test.ts
//
// O mapeamento saiu do laço do cron para servir também à importação por chave: os dois caminhos
// têm de gravar o MESMO cabeçalho para a mesma NF-e.
import { mapearCabecalho, parseOmieDate } from "./cabecalho.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const CHAVE = "31260912345678000190550010000123451000123456";

Deno.test("parseOmieDate: DD/MM/YYYY vira YYYY-MM-DD; vazio vira null", () => {
  assertEquals(parseOmieDate("05/09/2026"), "2026-09-05");
  assertEquals(parseOmieDate(""), null);
  assertEquals(parseOmieDate(null), null);
});

Deno.test("mapearCabecalho: cabeçalho real do ConsultarRecebimento vira a linha de nfe_recebimentos", () => {
  assertEquals(
    mapearCabecalho(
      {
        nIdNfe: "998877",
        cNumeroNFe: 12345,
        cSerieNFe: "1",
        cCNPJ_CPF: "12.345.678/0001-90",
        cRazaoSocial: "SAYERLACK IND. E COM. LTDA",
        dEmissaoNFe: "24/09/2026",
        nValorNFe: "18450.75",
      },
      "wh-oben",
      CHAVE,
      "4455667788",
    ),
    {
      warehouse_id: "wh-oben",
      numero_nfe: "12345",
      serie_nfe: "1",
      chave_acesso: CHAVE,
      cnpj_emitente: "12345678000190",
      razao_social_emitente: "SAYERLACK IND. E COM. LTDA",
      data_emissao: "2026-09-24",
      valor_total: 18450.75,
      status: "pendente",
      omie_nfe_id: 998877,
      omie_id_receb: 4455667788,
    },
  );
});

Deno.test("mapearCabecalho: sem razão social usa cNome; sem valor nem nIdNfe fica null", () => {
  const linha = mapearCabecalho({ cNome: "FORNECEDOR X" }, "wh-cc", CHAVE, 1);
  assertEquals(linha.razao_social_emitente, "FORNECEDOR X");
  assertEquals(linha.valor_total, null);
  assertEquals(linha.omie_nfe_id, null);
  assertEquals(linha.numero_nfe, "");
});
