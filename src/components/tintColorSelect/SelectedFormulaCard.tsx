// Card de detalhe da cor selecionada: preço, fonte, desconto e embalagens alternativas.
// Extraído verbatim de src/components/TintColorSelectDialog.tsx (god-component split).
import { Loader2, History, Package, Palette } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import type { Product } from '@/hooks/useUnifiedOrder';
import { fmt } from '@/hooks/useUnifiedOrder';
import type { FormulaResult, AlternativePackaging } from './types';

type PriceSource = 'cliente' | 'tabela' | 'calculado';

interface SelectedFormulaCardProps {
  selectedFormula: FormulaResult;
  loadingLastPrice: boolean;
  lastPracticedPrice: { price: number; date: string } | null | undefined;
  precoCsv: number;
  priceSource: string;
  setPriceSourceOverride: (s: PriceSource | null) => void;
  precoFinal: number;
  precoSemDesconto: number;
  discountPct: number;
  setDiscountPct: (n: number) => void;
  syncDiscount: boolean;
  setSyncDiscount: (v: boolean) => void;
  alternatives: AlternativePackaging[] | undefined;
  loadingAlternatives: boolean;
  altDiscounts: Record<string, number>;
  setAltDiscounts: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  custoCorantes: number;
  onConfirm: (formulaId: string, corId: string, nomeCor: string, precoFinal: number, custoCorantes: number, alternativeProduct?: Product) => void;
}

export function SelectedFormulaCard({
  selectedFormula,
  loadingLastPrice,
  lastPracticedPrice,
  precoCsv,
  priceSource,
  setPriceSourceOverride,
  precoFinal,
  precoSemDesconto,
  discountPct,
  setDiscountPct,
  syncDiscount,
  setSyncDiscount,
  alternatives,
  loadingAlternatives,
  altDiscounts,
  setAltDiscounts,
  custoCorantes,
  onConfirm,
}: SelectedFormulaCardProps) {
  return (
    <Card className="border-primary/30">
      <CardContent className="pt-4 space-y-3">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs font-mono">{selectedFormula.cor_id}</Badge>
          <span className="text-sm font-medium">{selectedFormula.nome_cor}</span>
        </div>

        {/* Last practiced price for this customer */}
        {loadingLastPrice ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : lastPracticedPrice ? (
          <div className="flex items-center gap-2 p-2 rounded-md bg-primary/5 border border-primary/20">
            <History className="w-3.5 h-3.5 text-primary shrink-0" />
            <div className="text-xs">
              <span className="font-medium text-primary">Último preço cliente: {fmt(lastPracticedPrice.price)}</span>
              {precoCsv > 0 && lastPracticedPrice.price < precoCsv && (
                <Badge variant="secondary" className="ml-1.5 text-[9px] px-1.5 py-0 text-status-warning-bold bg-status-warning-bg border-status-warning/30">
                  -{Math.round((1 - lastPracticedPrice.price / precoCsv) * 100)}% da tabela
                </Badge>
              )}
              <span className="text-muted-foreground ml-1">
                ({new Date(lastPracticedPrice.date).toLocaleDateString('pt-BR')})
              </span>
            </div>
          </div>
        ) : null}

        {/* Price source selection when multiple options available */}
        {lastPracticedPrice && precoCsv > 0 ? (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Selecionar preço</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setPriceSourceOverride('cliente')}
                className={`flex items-center gap-1 px-2 py-1 rounded-md border text-xs transition-all ${priceSource === 'cliente' ? 'border-primary bg-primary/10 text-primary font-semibold' : 'border-border hover:border-primary/50'}`}
              >
                <History className="w-3 h-3" />
                Cliente {fmt(lastPracticedPrice.price)}
              </button>
              <button
                onClick={() => setPriceSourceOverride('tabela')}
                className={`flex items-center gap-1 px-2 py-1 rounded-md border text-xs transition-all ${priceSource === 'tabela' ? 'border-primary bg-primary/10 text-primary font-semibold' : 'border-border hover:border-primary/50'}`}
              >
                Tabela {fmt(precoCsv)}
              </button>
            </div>
          </div>
        ) : null}

        {/* Price breakdown */}
        <div className="space-y-2">
          {/* Main price */}
          <div className="flex justify-between text-sm font-bold border-b pb-2">
            <span className="flex items-center gap-1.5">
              Preço Final
              <Badge variant="secondary" className="text-[9px] px-1.5 py-0">
                {priceSource === 'cliente' ? 'Preço cliente' : 'Tabela'}
              </Badge>
            </span>
            <span className="text-primary">{fmt(precoFinal)}</span>
          </div>

          {/* Discount field */}
          <div className="flex items-center gap-2 pt-1">
            <label className="text-xs text-muted-foreground whitespace-nowrap">Desconto %</label>
            <Input
              type="number"
              min={0}
              max={100}
              step={1}
              value={discountPct || ''}
              onChange={(e) => setDiscountPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
              className="h-7 w-20 text-xs text-right"
              placeholder="0"
            />
            {discountPct > 0 && (
              <span className="text-[10px] text-muted-foreground line-through">{fmt(precoSemDesconto)}</span>
            )}
          </div>
          {alternatives && alternatives.length > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="sync-discount"
                checked={syncDiscount}
                onCheckedChange={(v) => setSyncDiscount(!!v)}
                className="h-3.5 w-3.5"
              />
              <label htmlFor="sync-discount" className="text-[10px] text-muted-foreground cursor-pointer">
                Aplicar mesmo desconto nas outras embalagens
              </label>
            </div>
          )}
        </div>

        <Button
          size="sm"
          onClick={() => onConfirm(
            selectedFormula.id,
            selectedFormula.cor_id,
            selectedFormula.nome_cor,
            precoFinal,
            custoCorantes,
          )}
        >
          <Palette className="w-3.5 h-3.5 mr-1.5" />
          Adicionar ao Pedido — {fmt(precoFinal)}
        </Button>

        {/* Alternative packagings */}
        {loadingAlternatives ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
            <Loader2 className="w-3 h-3 animate-spin" />
            Buscando outras embalagens...
          </div>
        ) : alternatives && alternatives.length > 0 ? (
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-1.5 text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">
              <Package className="w-3 h-3" />
              Mesma cor em outras embalagens
            </div>
            <div className="space-y-1.5">
              {alternatives.map((alt, idx) => {
                const prevAlt = idx > 0 ? alternatives[idx - 1] : null;
                const showDivider = prevAlt && prevAlt.sameAcabamento && !alt.sameAcabamento;
                const altBasePrice = alt.precoFinalCsv && alt.precoFinalCsv > 0
                  ? alt.precoFinalCsv
                  : alt.product.valor_unitario + custoCorantes;
                const altDisc = syncDiscount ? discountPct : (altDiscounts[alt.formulaId] || 0);
                const altPrice = altDisc > 0 ? Math.round(altBasePrice * (1 - altDisc / 100) * 100) / 100 : altBasePrice;
                return (
                  <>
                    {showDivider && (
                      <div className="flex items-center gap-2 pt-1 pb-0.5">
                        <div className="flex-1 border-t border-border" />
                        <span className="text-[9px] text-muted-foreground uppercase tracking-wider">Outros acabamentos</span>
                        <div className="flex-1 border-t border-border" />
                      </div>
                    )}
                    <div className={`rounded-md border transition-all text-xs group ${alt.sameAcabamento ? 'border-primary/30 bg-primary/5' : 'border-border hover:border-primary/50'}`}>
                    <button
                      onClick={() => onConfirm(
                        alt.formulaId,
                        selectedFormula.cor_id,
                        selectedFormula.nome_cor,
                        altPrice,
                        custoCorantes,
                        alt.product,
                      )}
                      className="w-full flex items-center justify-between gap-2 p-2 hover:bg-primary/5"
                    >
                      <div className="flex-1 text-left min-w-0">
                        <p className="font-medium group-hover:text-primary transition-colors break-words whitespace-normal">
                          {alt.productDescricao}
                        </p>
                        <p className="text-[10px] text-muted-foreground font-mono">{alt.productCodigo}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-bold text-primary">{fmt(altPrice)}</span>
                        {altDisc > 0 && <span className="text-[10px] text-muted-foreground line-through ml-1">{fmt(altBasePrice)}</span>}
                        {alt.precoFinalCsv && alt.precoFinalCsv > 0 ? (
                          <Badge variant="secondary" className="text-[8px] px-1 py-0 ml-1">Tabela</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[8px] px-1 py-0 ml-1">Calc.</Badge>
                        )}
                      </div>
                    </button>
                    <div className="flex items-center gap-2 px-2 pb-2" onClick={(e) => e.stopPropagation()}>
                      <label className="text-[10px] text-muted-foreground whitespace-nowrap">Desconto %</label>
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={altDisc || ''}
                        onChange={(e) => setAltDiscounts(prev => ({ ...prev, [alt.formulaId]: Math.min(100, Math.max(0, Number(e.target.value) || 0)) }))}
                        className="h-6 w-16 text-[10px] text-right"
                        placeholder="0"
                      />
                    </div>
                  </div>
                  </>
                );
              })}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
