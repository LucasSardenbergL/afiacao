// Tipos do diálogo de seleção de cor tintométrica.
// Extraídos verbatim de src/components/TintColorSelectDialog.tsx (god-component split).
import type { Product } from '@/hooks/useUnifiedOrder';
import type { TintPriceSource } from '@/lib/tint/select-price';

/** Fase 3: metadados de precificação que o item CARREGA até a fronteira —
 *  a fonte escolhida pela vendedora + o desconto declarado + o preço-base.
 *  O gate do submit (tint_gate_revalida) recomputa a fonte AGORA e confere. */
export interface TintPricingMeta {
  /** Fonte efetivamente usada no preço confirmado (null = indisponível). */
  source: TintPriceSource | null;
  /** Desconto % aplicado por cima do preço da fonte (0–100). */
  discountPct: number;
  /** Preço da fonte ANTES do desconto (o que o gate recomputa). */
  precoSemDesconto: number | null;
}

export interface TintColorSelectDialogProps {
  product: Product;
  open: boolean;
  onClose: () => void;
  onConfirm: (formulaId: string, corId: string, nomeCor: string, precoFinal: number, custoCorantes: number, pricingMeta: TintPricingMeta, alternativeProduct?: Product) => void;
  customerUserId?: string | null;
  /** Pré-preenche a busca de cor ao abrir (re-pedido via "Cores do cliente"). */
  initialSearch?: string | null;
}

export interface FormulaResult {
  id: string;
  cor_id: string;
  nome_cor: string;
  preco_final_sayersystem: number | null;
  /** Fase 2b: CSV da chave — desde a migration 20260722100002 a view GARANTE
   *  que, quando a canônica é SL, o max lê só linhas não-SL (a versão anterior
   *  da tinta). Alimenta a fonte "Tabela" do seletor. */
  preco_csv_legado?: number | null;
  /** Canônica é a geração SL viva — decide o rótulo condicional da fonte CSV
   *  ("Tabela (versão anterior)"). Ausente/false → rótulo genérico "Tabela". */
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
  /** Canônica da alternativa é SL — rótulo condicional do picker de fonte. */
  isSl?: boolean | null;
}
