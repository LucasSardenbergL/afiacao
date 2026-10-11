import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { track } from '@/lib/analytics';
import { Search, Palette, Loader2, AlertTriangle } from 'lucide-react';
import type { TintColorSelectDialogProps } from './tintColorSelect/types';
import { useTintColorSelect } from './tintColorSelect/useTintColorSelect';
import { FormulaSearchResults } from './tintColorSelect/FormulaSearchResults';
import { GlobalColorMatches } from './tintColorSelect/GlobalColorMatches';
import { SelectedFormulaCard } from './tintColorSelect/SelectedFormulaCard';

export function TintColorSelectDialog({ product, open, onClose, onConfirm, customerUserId, initialSearch }: TintColorSelectDialogProps) {
  const {
    search,
    buscaEstavel,
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
    altPriceError,
    falhaLeitura,
    skuError,
    tentarDeNovo,
    discountPct,
    setDiscountPct,
    altDiscounts,
    setAltDiscounts,
    syncDiscount,
    setSyncDiscount,
    priceSource,
    setPriceSourceOverride,
    altPriceSourceOverrides,
    setAltPriceSourceOverride,
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

  // Teclado contínuo: o foco nunca sai da busca. ↑↓ realçam um resultado, Enter o
  // seleciona; com a cor selecionada, Enter = "Adicionar ao Pedido" SÓ se o botão
  // estaria habilitado (o card decide — `adicionarRef` devolve false se não pode).
  const [realce, setRealce] = useState(0);
  const adicionarRef = useRef<(() => boolean) | null>(null);
  const listaVisivel = !!formulas && formulas.length > 0 && !selectedFormula;
  useEffect(() => { setRealce(0); }, [formulas]);

  const onBuscaKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (listaVisivel && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const ultimo = formulas!.length - 1;
      setRealce((r) => (e.key === 'ArrowDown' ? Math.min(ultimo, r + 1) : Math.max(0, r - 1)));
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (selectedFormula) {
      adicionarRef.current?.();
      return;
    }
    // Só seleciona o que está na tela PARA O TEXTO DIGITADO — Enter antes do debounce
    // pegaria um resultado da busca anterior.
    if (listaVisivel && buscaEstavel && !loadingFormulas) {
      const f = formulas![Math.min(realce, formulas!.length - 1)];
      if (f) setSelectedFormula(f);
    }
  };

  // Fim do funil: a cor saiu do app pro pedido (≠ do Omie). `fonte` e `alternativa` dizem
  // por qual caminho — o mesmo SKU, outra embalagem/base, ou a busca global.
  const confirmar: typeof onConfirm = (formulaId, corId, nomeCor, precoFinalItem, custo, meta, alternativeProduct) => {
    track('tint.cor_confirmada', {
      fonte: meta.source ?? 'nenhuma',
      alternativa: !!alternativeProduct,
      com_desconto: meta.discountPct > 0,
    });
    onConfirm(formulaId, corId, nomeCor, precoFinalItem, custo, meta, alternativeProduct);
  };

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

        {/* Falha de LEITURA ≠ "não existe": sem este aviso a falha virava "base não
            configurada" / tela em branco e a vendedora voltava pro Omie. */}
        {falhaLeitura && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-xs">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="space-y-2">
              <span className="block">Não consegui carregar as cores agora (falha de conexão ou do servidor). Isso não significa que a cor não exista.</span>
              <Button size="touch" variant="outline" onClick={tentarDeNovo}>Tentar de novo</Button>
            </div>
          </div>
        )}

        {skuId === null && !loadingSku && !skuError ? (
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
                onKeyDown={onBuscaKeyDown}
                role="combobox"
                aria-expanded={listaVisivel}
                aria-activedescendant={listaVisivel ? `tint-cor-${realce}` : undefined}
                className="pl-9 h-9 [@media(pointer:coarse)]:h-11"
                autoFocus
              />
            </div>

            {loadingFormulas && <Loader2 className="w-4 h-4 animate-spin mx-auto my-4" />}

            {listaVisivel && (
              <FormulaSearchResults formulas={formulas!} onSelect={setSelectedFormula} realce={realce} idPrefixo="tint-cor" />
            )}

            {colorNotFoundInBase && !loadingGlobalColors && (
              <GlobalColorMatches
                product={product}
                matches={globalColorMatches ?? []}
                colorExists={globalColorExists}
                precoMap={altPriceMap}
                precoLoading={altPriceLoading}
                altPriceSourceOverrides={altPriceSourceOverrides}
                setAltPriceSourceOverride={setAltPriceSourceOverride}
                onConfirm={confirmar}
              />
            )}
            {loadingGlobalColors && <Loader2 className="w-4 h-4 animate-spin mx-auto my-4" />}
            {altPriceError && !altPriceLoading && (
              <div className="space-y-2">
                <p className="text-xs text-status-error">
                  Não consegui calcular o preço das outras embalagens agora — aparecem sem preço. Toque em &quot;Tentar de novo&quot;.
                </p>
                <Button size="touch" variant="outline" onClick={tentarDeNovo}>Tentar de novo</Button>
              </div>
            )}

            {selectedFormula && (
              <SelectedFormulaCard
                selectedFormula={selectedFormula}
                loadingLastPrice={loadingLastPrice}
                lastPracticedPrice={lastPracticedPrice}
                precoCsv={precoCsv}
                priceSource={priceSource}
                setPriceSourceOverride={setPriceSourceOverride}
                altPriceSourceOverrides={altPriceSourceOverrides}
                setAltPriceSourceOverride={setAltPriceSourceOverride}
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
                onConfirm={confirmar}
                adicionarRef={adicionarRef}
                onTentarDeNovo={tentarDeNovo}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
