// Lista de bases alternativas quando a cor não existe na base atual.
// Extraída verbatim de src/components/TintColorSelectDialog.tsx (god-component split).
import { AlertTriangle, Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { Product } from '@/hooks/useUnifiedOrder';
import { fmt } from '@/hooks/useUnifiedOrder';
import type { AlternativePackaging } from './types';

interface GlobalColorMatchesProps {
  product: Product;
  matches: AlternativePackaging[];
  /** A cor existe no catálogo, mas sem embalagem vendável p/ esta base (vs. não existir de todo). */
  colorExists?: boolean;
  onConfirm: (formulaId: string, corId: string, nomeCor: string, precoFinal: number, custoCorantes: number, alternativeProduct?: Product) => void;
}

export function GlobalColorMatches({ product, matches, colorExists, onConfirm }: GlobalColorMatchesProps) {
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
            const altBasePrice = alt.precoFinalCsv && alt.precoFinalCsv > 0
              ? alt.precoFinalCsv
              : alt.product.valor_unitario;
            return (
              <div key={alt.formulaId} className="rounded-md border border-border hover:border-primary/50 transition-all text-xs">
                <button
                  onClick={() => onConfirm(
                    alt.formulaId,
                    alt.corId || '',
                    alt.nomeCor || '',
                    altBasePrice,
                    0,
                    alt.product,
                  )}
                  className="w-full flex items-center justify-between gap-2 p-2.5 hover:bg-primary/5"
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
                    <span className="font-bold text-primary">{fmt(altBasePrice)}</span>
                    {alt.precoFinalCsv && alt.precoFinalCsv > 0 ? (
                      <Badge variant="secondary" className="text-[8px] px-1 py-0 ml-1">Tabela</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[8px] px-1 py-0 ml-1">Base</Badge>
                    )}
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
