// Mapeamento PURO dos itens do `ConsultarRecebimento` (Omie) → linhas de `nfe_recebimento_itens`.
// Separado do index.ts para ser testado no runtime real (itens_test.ts).

interface OmieItemCabec {
  nSequencia?: number;
  cCodigoProduto?: string | null;
  cDescricaoProduto?: string | null;
  cNCM?: string | null;
  cEAN?: string | null;
  cUnidadeNfe?: string | null;
  nQtdeNFe?: number | string | null;
  nPrecoUnit?: number | string | null;
  vTotalItem?: number | string | null;
  nIdProduto?: number | string | null;
}

export interface OmieRecebimentoItem {
  itensCabec?: OmieItemCabec;
  [key: string]: unknown;
}

export interface ItemRecebimentoRow {
  nfe_recebimento_id: string;
  sequencia: number;
  codigo_produto: string | null;
  descricao: string;
  ncm: string | null;
  ean: string | null;
  unidade_nfe: string;
  quantidade_nfe: number;
  valor_unitario: number | null;
  valor_total: number | null;
  unidade_estoque: null;
  quantidade_convertida: null;
  quantidade_conferida: number;
  quantidade_esperada: number;
  status_item: string;
  produto_omie_id: number | null;
}

function smartRound(qty: number): number {
  const rounded = Math.round(qty);
  return Math.abs(qty - rounded) < 0.05 ? rounded : Math.ceil(qty);
}

/**
 * O NCM em 8 dígitos, que é o que cabe em `nfe_recebimento_itens.ncm` (`varchar(8)`).
 *
 * O Omie devolve o NCM PONTUADO (`2909.60.90`), e gravá-lo cru estourava a coluna: 22001 no
 * insert do lote inteiro, e toda NF-e de produção ficou só com o cabeçalho (0 itens, medido em
 * 2026-09-26). O NCM é o bloco `dddd.dd.dd` do início (pontos opcionais); o que vem depois de um
 * separador não-dígito é extensão (EX TIPI, ex.: `3920.49.00.01`) e não faz parte dele. Qualquer
 * outra forma vira `null`: ausente, nunca um código fabricado por corte ou preenchimento.
 */
export function normalizarNcm(bruto: string | null | undefined): string | null {
  if (bruto == null) return null;
  const m = /^\s*(\d{4})\.?(\d{2})\.?(\d{2})(?:\D.*)?$/.exec(bruto);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

export function mapearItensRecebimento(
  rawItems: OmieRecebimentoItem[],
  nfeRecebimentoId: string,
): ItemRecebimentoRow[] {
  return rawItems.map((item, idx) => {
    const iCabec: OmieItemCabec = item.itensCabec ?? (item as unknown as OmieItemCabec);
    const quantidadeNfe = parseFloat(String(iCabec.nQtdeNFe ?? 0));
    return {
      nfe_recebimento_id: nfeRecebimentoId,
      sequencia: iCabec.nSequencia ?? idx + 1,
      codigo_produto: iCabec.cCodigoProduto ?? null,
      descricao: iCabec.cDescricaoProduto ?? "Item",
      ncm: normalizarNcm(iCabec.cNCM),
      ean: iCabec.cEAN ?? null,
      unidade_nfe: iCabec.cUnidadeNfe ?? "UN",
      quantidade_nfe: quantidadeNfe,
      valor_unitario: iCabec.nPrecoUnit ? parseFloat(String(iCabec.nPrecoUnit)) : null,
      valor_total: iCabec.vTotalItem ? parseFloat(String(iCabec.vTotalItem)) : null,
      unidade_estoque: null,
      quantidade_convertida: null,
      quantidade_conferida: 0,
      quantidade_esperada: smartRound(quantidadeNfe),
      status_item: "pendente",
      produto_omie_id: iCabec.nIdProduto ? parseInt(String(iCabec.nIdProduto)) : null,
    };
  });
}
