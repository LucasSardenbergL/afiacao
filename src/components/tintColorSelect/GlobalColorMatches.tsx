// Lista de bases alternativas quando a cor não existe na base atual.
// Extraída verbatim de src/components/TintColorSelectDialog.tsx (god-component split).
import { AlertTriangle, Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { Product } from '@/hooks/useUnifiedOrder';
import { fmt } from '@/hooks/useUnifiedOrder';
import { selectAltPrice, type AltPriceSource, type TintPriceBreakdownLite } from '@/lib/tint/select-price';
import { AltPriceSourcePicker } from './AltPriceSourcePicker';
import type { AlternativePackaging, TintPricingMeta } from './types';

interface GlobalColorMatchesProps {
  product: Product;
  matches: AlternativePackaging[];
  /** A cor existe no catálogo, mas sem embalagem vendável p/ esta base (vs. não existir de todo). */
  colorExists?: boolean;
  /** Preço honesto (motor batch) por formulaId dos matches. */
  precoMap?: Record<string, TintPriceBreakdownLite>;
  /** Batch de preços ainda carregando (mostra "calculando", não "sem preço"). */
  precoLoading?: boolean;
  /** Override de fonte POR alternativa (Fase 2b-fix) — validado em selectAltPrice. */
  altPriceSourceOverrides: Record<string, AltPriceSource>;
  setAltPriceSourceOverride: (formulaId: string, source: AltPriceSource) => void;
  onConfirm: (formulaId: string, corId: string, nomeCor: string, precoFinal: number, custoCorantes: number, pricingMeta: TintPricingMeta, alternativeProduct?: Product) => void;
}

export function GlobalColorMatches({ product, matches, colorExists, precoMap, precoLoading, altPriceSourceOverrides, setAltPriceSourceOverride, onConfirm }: GlobalColorMatchesProps) {
  if (matches.length === 0) {
    // Degradação honesta: distingue "existe mas não é vendável nesta base" de
    // "não existe". O sinal money-path nunca afirma ausência quando a cor está
    // no catálogo (só falta vincular o produto Omie / é de outra família de base).
    if (colorExists) {
      return (
        <div className="flex items-start gap-2 p-3 rounded-md bg-status-warning-bg border border-status-warning/30">
          <AlertTriangle className="w-5 h-5 text-status-warning shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-status-warning-foreground">
              Esta cor existe, mas não há embalagem vendável para esta base
            </p>
            <p className="text-xs text-status-warning mt-1">
              A cor está no catálogo, mas nenhuma embalagem dela está vinculada a um produto Omie vendável na família de <strong>{product.descricao}</strong>. Avise o tintométrico para vincular ou cadastrar o produto.
            </p>
          </div>
        </div>
      );
    }
    return <p className="text-xs text-muted-foreground text-center py-4">Nenhuma cor encontrada em nenhuma base.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 p-3 rounded-md bg-status-warning-bg border border-status-warning/30">
        <AlertTriangle className="w-5 h-5 text-status-warning shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-status-warning-foreground">
            Esta cor não pode ser feita nesta base
          </p>
          <p className="text-xs text-status-warning mt-1">
            A cor pesquisada não está disponível em <strong>{product.descricao}</strong>. Veja abaixo as embalagens onde ela pode ser produzida:
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">
          <Package className="w-3 h-3" />
          Bases disponíveis para esta cor
        </div>
        <div className="max-h-60 overflow-y-auto space-y-1.5">
          {matches.map((alt) => {
            // Preço honesto da base alternativa (motor batch): calc vs CSV; null = sem preço.
            // Fase 2b-fix: a escolha manual da vendedora (quando houver) entra como override validado.
            const altSel = selectAltPrice(alt.precoFinalCsv, precoMap?.[alt.formulaId] ?? null, altPriceSourceOverrides[alt.formulaId] ?? null);
            const altDisponivel = altSel.preco != null;
            return (
              <div key={alt.formulaId} className="rounded-md border border-border hover:border-primary/50 transition-all text-xs">
                <button
                  disabled={!altDisponivel}
                  onClick={() => altDisponivel && onConfirm(
                    alt.formulaId,
                    alt.corId || '',
                    alt.nomeCor || '',
                    altSel.preco as number,
                    altSel.custoCorantes,
                    // Fase 3: o item carrega a fonte EFETIVA (altSel já aplicou o
                    // override da vendedora — 2b-fix); busca global não tem desconto
                    { source: altSel.fonte, discountPct: 0, precoSemDesconto: altSel.preco },
                    alt.product,
                  )}
                  className={`w-full flex items-center justify-between gap-2 p-2.5 ${altDisponivel ? 'hover:bg-primary/5' : 'opacity-60 cursor-not-allowed'}`}
                >
                  <div className="flex-1 text-left min-w-0">
                    <p className="font-medium break-words whitespace-normal">
                      {alt.productDescricao}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-muted-foreground font-mono">{alt.productCodigo}</span>
                      {alt.corId && (
                        <Badge variant="outline" className="text-[8px] px-1 py-0">{alt.corId}</Badge>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {altDisponivel ? (
                      <>
                        <span className="font-bold text-primary">{fmt(altSel.preco as number)}</span>
                        {altSel.fonte === 'tabela' ? (
                          <Badge variant="secondary" className="text-[8px] px-1 py-0 ml-1">Tabela</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[8px] px-1 py-0 ml-1">Calc.</Badge>
                        )}
                        {altSel.recalculado && (
                          <Badge variant="outline" className="text-[8px] px-1 py-0 ml-1 text-status-info border-status-info/40">recalc.</Badge>
                        )}
                      </>
                    ) : precoLoading ? (
                      <span className="text-[10px] text-muted-foreground">calculando…</span>
                    ) : (
                      <span className="text-[10px] font-medium text-status-warning">sem preço</span>
                    )}
                  </div>
                </button>
                <AltPriceSourcePicker
                  formulaId={alt.formulaId}
                  altSel={altSel}
                  setOverride={setAltPriceSourceOverride}
                  className="px-2.5 pb-2"
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
