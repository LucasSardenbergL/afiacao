// Tipos do diálogo de seleção de cor tintométrica.
// Extraídos verbatim de src/components/TintColorSelectDialog.tsx (god-component split).
import type { Product } from '@/hooks/useUnifiedOrder';

export interface TintColorSelectDialogProps {
  product: Product;
  open: boolean;
  onClose: () => void;
  onConfirm: (formulaId: string, corId: string, nomeCor: string, precoFinal: number, custoCorantes: number, alternativeProduct?: Product) => void;
  customerUserId?: string | null;
  /** Pré-preenche a busca de cor ao abrir (re-pedido via "Cores do cliente"). */
  initialSearch?: string | null;
}

export interface FormulaResult {
  id: string;
  cor_id: string;
  nome_cor: string;
  preco_final_sayersystem: number | null;
}

export interface AlternativePackaging {
  formulaId: string;
  skuId: string;
  omieProductId: string;
  productDescricao: string;
  productCodigo: string;
  precoFinalCsv: number | null;
  product: Product;
  sameAcabamento: boolean;
  corId?: string;
  nomeCor?: string;
}
