import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Search, Palette, Loader2, AlertTriangle } from 'lucide-react';
import { useTintPricing } from '@/hooks/useTintPricing';
import type { Product } from '@/hooks/useUnifiedOrder';
import { fmt } from '@/hooks/useUnifiedOrder';

interface TintColorSelectDialogProps {
  product: Product;
  open: boolean;
  onClose: () => void;
  onConfirm: (formulaId: string, corId: string, nomeCor: string, precoFinal: number, custoCorantes: number) => void;
}

interface FormulaResult {
  id: string;
  cor_id: string;
  nome_cor: string;
  preco_final_sayersystem: number | null;
}

export function TintColorSelectDialog({ product, open, onClose, onConfirm }: TintColorSelectDialogProps) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedFormula, setSelectedFormula] = useState<FormulaResult | null>(null);

  useEffect(() => {
    if (!open) {
      setSearch('');
      setDebouncedSearch('');
      setSelectedFormula(null);
    }
  }, [open]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Find SKU id for this omie product
  const { data: skuId, isLoading: loadingSku } = useQuery({
    queryKey: ['tint-sku-for-product', product.id],
    staleTime: 5 * 60 * 1000,
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_skus')
        .select('id')
        .eq('omie_product_id', product.id)
        .eq('account', 'oben')
        .limit(1)
        .maybeSingle();
      return data?.id || null;
    },
  });

  // Search formulas
  const { data: formulas, isLoading: loadingFormulas } = useQuery({
    queryKey: ['tint-formula-search', skuId, debouncedSearch],
    enabled: !!skuId && debouncedSearch.length >= 2,
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_formulas')
        .select('id, cor_id, nome_cor, preco_final_sayersystem')
        .eq('account', 'oben')
        .eq('sku_id', skuId!)
        .or(`cor_id.ilike.%${debouncedSearch}%,nome_cor.ilike.%${debouncedSearch}%`)
        .limit(20);
      return (data || []) as FormulaResult[];
    },
  });

  // Pricing breakdown for selected formula
  const { data: pricing, isLoading: loadingPricing } = useTintPricing(selectedFormula?.id || null);

  const precoBase = product.valor_unitario;
  const custoCorantes = pricing?.custoCorantes || 0;
  const precoFinal = precoBase + custoCorantes;

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
                onChange={e => { setSearch(e.target.value); setSelectedFormula(null); }}
                className="pl-9 h-9"
                autoFocus
              />
            </div>

            {loadingFormulas && <Loader2 className="w-4 h-4 animate-spin mx-auto my-4" />}

            {formulas && formulas.length > 0 && !selectedFormula && (
              <div className="max-h-48 overflow-y-auto border rounded-md divide-y">
                {formulas.map(f => (
                  <button
                    key={f.id}
                    onClick={() => setSelectedFormula(f)}
                    className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors text-xs flex items-center gap-2"
                  >
                    <Palette className="w-3 h-3 text-primary shrink-0" />
                    <span className="font-mono font-medium">{f.cor_id}</span>
                    <span className="text-muted-foreground">—</span>
                    <span className="truncate">{f.nome_cor}</span>
                  </button>
                ))}
              </div>
            )}

            {debouncedSearch.length >= 2 && formulas && formulas.length === 0 && !loadingFormulas && (
              <p className="text-xs text-muted-foreground text-center py-4">Nenhuma cor encontrada.</p>
            )}

            {selectedFormula && (
              <Card className="border-primary/30">
                <CardContent className="pt-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs font-mono">{selectedFormula.cor_id}</Badge>
                    <span className="text-sm font-medium">{selectedFormula.nome_cor}</span>
                  </div>

                  {/* Price breakdown */}
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">Preço da base</span>
                      <span className="font-medium">{fmt(precoBase)}</span>
                    </div>

                    {loadingPricing ? (
                      <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                    ) : pricing && pricing.itensCorantes.length > 0 ? (
                      <>
                        <div className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">Corantes</div>
                        <div className="space-y-1">
                          {pricing.itensCorantes.map((item, i) => (
                            <div key={i} className="flex justify-between text-xs">
                              <span className="text-muted-foreground truncate max-w-[60%]">
                                {item.coranteDescricao.split(' - ').pop() || item.coranteDescricao}
                                <span className="ml-1 text-[10px]">({item.qtdMl.toFixed(2)} ml)</span>
                              </span>
                              {item.custoDisponivel ? (
                                <span>{fmt(item.custoItem)}</span>
                              ) : (
                                <span className="text-muted-foreground italic">N/D</span>
                              )}
                            </div>
                          ))}
                        </div>
                        <div className="flex justify-between text-xs border-t pt-1">
                          <span className="text-muted-foreground">Total corantes</span>
                          <span className="font-medium">{fmt(custoCorantes)}</span>
                        </div>
                      </>
                    ) : null}

                    <div className="flex justify-between text-sm font-bold border-t pt-2">
                      <span>Preço Final</span>
                      <span className="text-primary">{fmt(precoFinal)}</span>
                    </div>

                    {selectedFormula.preco_final_sayersystem != null && selectedFormula.preco_final_sayersystem > 0 && (
                      <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>Preço CSV (referência)</span>
                        <span>{fmt(selectedFormula.preco_final_sayersystem)}</span>
                      </div>
                    )}
                  </div>

                  <Button
                    className="w-full"
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
                    Adicionar ao Pedido
                  </Button>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
