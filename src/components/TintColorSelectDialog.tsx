import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Search, Palette, Loader2, AlertTriangle } from 'lucide-react';
import type { TintColorSelectDialogProps } from './tintColorSelect/types';
import { useTintColorSelect } from './tintColorSelect/useTintColorSelect';
import { FormulaSearchResults } from './tintColorSelect/FormulaSearchResults';
import { GlobalColorMatches } from './tintColorSelect/GlobalColorMatches';
import { SelectedFormulaCard } from './tintColorSelect/SelectedFormulaCard';

export function TintColorSelectDialog({ product, open, onClose, onConfirm, customerUserId, initialSearch }: TintColorSelectDialogProps) {
  const {
    search,
    onSearchChange,
    loadingSku,
    skuId,
    formulas,
    loadingFormulas,
    colorNotFoundInBase,
    globalColorMatches,
    globalColorExists,
    loadingGlobalColors,
    selectedFormula,
    setSelectedFormula,
    lastPracticedPrice,
    loadingLastPrice,
    alternatives,
    loadingAlternatives,
    altPriceMap,
    altPriceLoading,
    discountPct,
    setDiscountPct,
    altDiscounts,
    setAltDiscounts,
    syncDiscount,
    setSyncDiscount,
    priceSource,
    setPriceSourceOverride,
    precoCsv,
    precoCalc,
    precoCliente,
    custoCorantes,
    precoSemDesconto,
    precoFinal,
    disponivel,
    precoCarregando,
    recalculado,
    precoImportadoAnterior,
    motivoSemPreco,
  } = useTintColorSelect({ product, open, customerUserId, initialSearch });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Palette className="w-4 h-4 text-primary" />
            Selecionar Cor
          </DialogTitle>
          <p className="text-xs text-muted-foreground">{product.descricao}</p>
        </DialogHeader>

        {skuId === null && !loadingSku ? (
          <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>Esta base não está configurada no módulo tintométrico. Configure o mapeamento em <strong>Tintométrico &gt; Mapeamento Omie</strong>.</span>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por código ou nome da cor..."
                value={search}
                onChange={e => onSearchChange(e.target.value)}
                className="pl-9 h-9"
                autoFocus
              />
            </div>

            {loadingFormulas && <Loader2 className="w-4 h-4 animate-spin mx-auto my-4" />}

            {formulas && formulas.length > 0 && !selectedFormula && (
              <FormulaSearchResults formulas={formulas} onSelect={setSelectedFormula} />
            )}

            {colorNotFoundInBase && !loadingGlobalColors && (
              <GlobalColorMatches
                product={product}
                matches={globalColorMatches ?? []}
                colorExists={globalColorExists}
                precoMap={altPriceMap}
                precoLoading={altPriceLoading}
                onConfirm={onConfirm}
              />
            )}
            {loadingGlobalColors && <Loader2 className="w-4 h-4 animate-spin mx-auto my-4" />}

            {selectedFormula && (
              <SelectedFormulaCard
                selectedFormula={selectedFormula}
                loadingLastPrice={loadingLastPrice}
                lastPracticedPrice={lastPracticedPrice}
                precoCsv={precoCsv}
                priceSource={priceSource}
                setPriceSourceOverride={setPriceSourceOverride}
                precoCalc={precoCalc}
                precoCliente={precoCliente}
                precoFinal={precoFinal}
                precoSemDesconto={precoSemDesconto}
                disponivel={disponivel}
                precoCarregando={precoCarregando}
                recalculado={recalculado}
                precoImportadoAnterior={precoImportadoAnterior}
                motivoSemPreco={motivoSemPreco}
                discountPct={discountPct}
                setDiscountPct={setDiscountPct}
                syncDiscount={syncDiscount}
                setSyncDiscount={setSyncDiscount}
                alternatives={alternatives}
                loadingAlternatives={loadingAlternatives}
                altPriceMap={altPriceMap}
                altPriceLoading={altPriceLoading}
                altDiscounts={altDiscounts}
                setAltDiscounts={setAltDiscounts}
                custoCorantes={custoCorantes}
                onConfirm={onConfirm}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
