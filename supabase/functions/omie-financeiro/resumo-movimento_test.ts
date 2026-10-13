// Testa o CÓDIGO REAL de resumo-movimento.ts no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-financeiro/resumo-movimento_test.ts
//
// Os payloads abaixo são transcritos de linhas REAIS de fin_movimentacoes.metadata (prod,
// 2026-10-13), não resumidos: o caso de juros é o boleto colacor de 165,00 pago com 5 dias de
// atraso, e o CC é a baixa da oben com nCodBaixa.
import { colunasResumo, dataOmie, idOmie, liquidadoOmie, tipoDocumentoOmie, valorOmie } from "./resumo-movimento.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

Deno.test("CONTA_A_RECEBER real com juros: tudo tipado, identidade preservada", () => {
  const c = colunasResumo(
    { nJuros: 6.05, nMulta: 0, nValPago: 165, nDesconto: 0, cLiquidado: "S", nValAberto: 0, nValLiquido: 171.05 },
    { cTipo: "BOL", nValorTitulo: 165, dDtPagamento: "25/02/2026", dDtVenc: "20/02/2026" } as Record<string, unknown>,
  );
  assertEquals(c, {
    resumo_val_pago: 165,
    resumo_val_liquido: 171.05,
    resumo_desconto: 0,
    resumo_juros: 6.05,
    resumo_multa: 0,
    resumo_val_aberto: 0,
    resumo_liquidado: true,
    valor_titulo: 165,
    tipo_documento: "BOL",
    omie_ncodbaixa: null,
    data_pagamento_omie: "2026-02-25",
    data_credito_omie: null,
  });
});

Deno.test("CONTA_CORRENTE_REC real: resumo só com nValPago — o resto é NULL, não 0", () => {
  const c = colunasResumo({ nValPago: 0 }, {
    cTipo: "CHQ", nCodBaixa: 12081592381, dDtPagamento: "27/04/2026", dDtCredito: "27/04/2026",
  });
  assertEquals(c.resumo_val_pago, 0, "0 que o Omie MANDOU continua 0");
  assertEquals(c.resumo_juros, null, "nJuros ausente não pode virar 0");
  assertEquals(c.resumo_multa, null);
  assertEquals(c.resumo_desconto, null);
  assertEquals(c.resumo_val_liquido, null);
  assertEquals(c.resumo_liquidado, null);
  assertEquals(c.omie_ncodbaixa, 12081592381);
  assertEquals(c.data_credito_omie, "2026-04-27");
});

Deno.test("resumo e detalhes ausentes: tudo NULL", () => {
  const c = colunasResumo(undefined, undefined);
  for (const [k, v] of Object.entries(c)) assertEquals(v, null, `${k} devia ser null`);
});

Deno.test("valorOmie: rejeita o que fabricaria número", () => {
  assertEquals(valorOmie(NaN), null);
  assertEquals(valorOmie(Infinity), null);
  assertEquals(valorOmie(-Infinity), null);
  assertEquals(valorOmie("6.05"), null, "string não é número do contrato");
  assertEquals(valorOmie(null), null);
  assertEquals(valorOmie(undefined), null);
  assertEquals(valorOmie(1e13), null, "estoura numeric(15,2) e derrubaria a página");
  assertEquals(valorOmie(9999999999999.99), 9999999999999.99);
  assertEquals(valorOmie(9999999999999.998), null, "arredonda para 1e13 no Postgres e estoura");
  assertEquals(valorOmie(6.054), 6.05, "grava o que o Postgres gravaria");
  assertEquals(valorOmie(-12.5), -12.5);
  assertEquals(valorOmie(0), 0);
});

Deno.test("liquidadoOmie: só S/N decidem", () => {
  assertEquals(liquidadoOmie("S"), true);
  assertEquals(liquidadoOmie("N"), false);
  assertEquals(liquidadoOmie("s"), null);
  assertEquals(liquidadoOmie(""), null);
  assertEquals(liquidadoOmie(undefined), null);
});

Deno.test("idOmie e tipoDocumentoOmie", () => {
  assertEquals(idOmie(0), null);
  assertEquals(idOmie(-1), null);
  assertEquals(idOmie(1.5), null);
  assertEquals(idOmie(2 ** 60), null, "fora do inteiro seguro perde precisão — não grava id errado");
  assertEquals(tipoDocumentoOmie("  BOL "), "BOL");
  assertEquals(tipoDocumentoOmie("   "), null);
  assertEquals(tipoDocumentoOmie(7), null);
});

Deno.test("dataOmie: só data de calendário válida", () => {
  assertEquals(dataOmie("25/02/2026"), "2026-02-25");
  assertEquals(dataOmie(" 29/02/2028 "), "2028-02-29");
  assertEquals(dataOmie("29/02/2026"), null, "2026 não é bissexto");
  assertEquals(dataOmie("45/13/2026"), null, "o parser legado devolveria 2026-13-45");
  assertEquals(dataOmie("5/2/2026"), null);
  assertEquals(dataOmie("2026-02-25"), null, "o contrato do Omie é DD/MM/AAAA");
  assertEquals(dataOmie(""), null);
  assertEquals(dataOmie(undefined), null);
});
