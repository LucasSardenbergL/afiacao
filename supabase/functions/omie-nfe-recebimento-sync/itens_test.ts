// Testa o CÓDIGO REAL de itens.ts no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-nfe-recebimento-sync/itens_test.ts
//
// O defeito: o Omie devolve o NCM PONTUADO (`2909.60.90`, 10 chars) e `nfe_recebimento_itens.ncm`
// é `varchar(8)` — o insert do lote de itens morria com 22001 e TODA NF-e de produção ficou só com
// o cabeçalho (0 linhas na tabela de itens, medido em 2026-09-26). As formas abaixo são as que
// existem nos payloads reais de `ConsultarRecebimento` guardados em prod.
import { mapearItensRecebimento, normalizarNcm, type OmieRecebimentoItem } from "./itens.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

Deno.test("normalizarNcm: o NCM pontuado do Omie vira os 8 dígitos que cabem na coluna", () => {
  assertEquals(normalizarNcm("2909.60.90"), "29096090");
  assertEquals(normalizarNcm("29096090"), "29096090");
  assertEquals(normalizarNcm(" 2909.60.90 "), "29096090");
});

Deno.test("normalizarNcm: sufixo depois de separador (EX TIPI) não entra — o NCM são os 8 primeiros", () => {
  // 2 itens reais de prod vêm assim: `3920.49.00.01` (10 dígitos no total).
  assertEquals(normalizarNcm("3920.49.00.01"), "39204900");
});

Deno.test("normalizarNcm: forma irreconhecível é AUSENTE (null), nunca um código fabricado", () => {
  assertEquals(normalizarNcm(null), null);
  assertEquals(normalizarNcm(undefined), null);
  assertEquals(normalizarNcm(""), null);
  assertEquals(normalizarNcm("2909.60"), null, "6 dígitos não é NCM");
  assertEquals(normalizarNcm("290960901"), null, "9 dígitos colados: não dá para saber onde o NCM acaba");
  assertEquals(normalizarNcm("SEM NCM"), null);
});

Deno.test("mapearItensRecebimento: item real do ConsultarRecebimento vira linha que cabe nas colunas", () => {
  const itens: OmieRecebimentoItem[] = [{
    itensCabec: {
      nSequencia: 3,
      cCodigoProduto: "SAY-FS-0123",
      cDescricaoProduto: "FUNDO SELADOR PU 3,6L",
      cNCM: "3208.90.10",
      cEAN: "7891466511901",
      cUnidadeNfe: "GL",
      nQtdeNFe: 12,
      nPrecoUnit: 145.9,
      vTotalItem: 1750.8,
      nIdProduto: 4155896651,
    },
  }];

  assertEquals(mapearItensRecebimento(itens, "nfe-1"), [{
    nfe_recebimento_id: "nfe-1",
    sequencia: 3,
    codigo_produto: "SAY-FS-0123",
    descricao: "FUNDO SELADOR PU 3,6L",
    ncm: "32089010",
    ean: "7891466511901",
    unidade_nfe: "GL",
    quantidade_nfe: 12,
    valor_unitario: 145.9,
    valor_total: 1750.8,
    unidade_estoque: null,
    quantidade_convertida: null,
    quantidade_conferida: 0,
    quantidade_esperada: 12,
    status_item: "pendente",
    produto_omie_id: 4155896651,
  }]);
});

Deno.test("mapearItensRecebimento: nenhum NCM do lote passa de 8 caracteres", () => {
  const itens: OmieRecebimentoItem[] = ["2909.60.90", "3920.49.00.01", "2909.60", null].map((cNCM, i) => ({
    itensCabec: { nSequencia: i + 1, cNCM, nQtdeNFe: 1 },
  }));

  const ncms = mapearItensRecebimento(itens, "nfe-1").map((l) => l.ncm);
  assertEquals(ncms, ["29096090", "39204900", null, null]);
});
