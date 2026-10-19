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

/** Linha do lote para a RPC `importar_nfe_recebimento`: sem `nfe_recebimento_id` (ela carimba o
 * cabeçalho que valer) e sem `quantidade_conferida`/`status_item` (ela força 0/pendente). */
export interface ItemRecebimentoRow {
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
  quantidade_esperada: number;
  produto_omie_id: number | null;
}

function smartRound(qty: number): number {
  const rounded = Math.round(qty);
  return Math.abs(qty - rounded) < 0.05 ? rounded : Math.ceil(qty);
}

// `normalizarNcm` mora em `_shared/ncm.ts` (o webhook também a usa, e import entre pastas de função
// não entra no bundle do Lovable); re-exportada aqui para quem já importava deste módulo.
export { normalizarNcm } from "../_shared/ncm.ts";
import { normalizarNcm } from "../_shared/ncm.ts";

export function mapearItensRecebimento(rawItems: OmieRecebimentoItem[]): ItemRecebimentoRow[] {
  return rawItems.map((item, idx) => {
    const iCabec: OmieItemCabec = item.itensCabec ?? (item as unknown as OmieItemCabec);
    const quantidadeNfe = parseFloat(String(iCabec.nQtdeNFe ?? 0));
    return {
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
      quantidade_esperada: smartRound(quantidadeNfe),
      produto_omie_id: iCabec.nIdProduto ? parseInt(String(iCabec.nIdProduto)) : null,
    };
  });
}
