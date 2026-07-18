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
  /** Fase 2b: CSV da chave (o preço da VERSÃO ANTERIOR da tinta quando a
   *  canônica é a geração SL viva) — alimenta a fonte "Tabela" do seletor. */
  preco_csv_legado?: number | null;
  /** true = geração SL (receita viva); false = SAYERLACK/personalizada. */
  is_sl?: boolean | null;
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
