import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Search, Palette, Loader2, AlertTriangle, History, Package } from 'lucide-react';
import { useTintPricing } from '@/hooks/useTintPricing';
import type { Product } from '@/hooks/useUnifiedOrder';
import { fmt } from '@/hooks/useUnifiedOrder';

interface TintColorSelectDialogProps {
  product: Product;
  open: boolean;
  onClose: () => void;
  onConfirm: (formulaId: string, corId: string, nomeCor: string, precoFinal: number, custoCorantes: number, alternativeProduct?: Product) => void;
  customerUserId?: string | null;
}

interface FormulaResult {
  id: string;
  cor_id: string;
  nome_cor: string;
  preco_final_sayersystem: number | null;
}

interface AlternativePackaging {
  formulaId: string;
  skuId: string;
  omieProductId: string;
  productDescricao: string;
  productCodigo: string;
  precoFinalCsv: number | null;
  product: Product;
}

export function TintColorSelectDialog({ product, open, onClose, onConfirm, customerUserId }: TintColorSelectDialogProps) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedFormula, setSelectedFormula] = useState<FormulaResult | null>(null);
  const [discountPct, setDiscountPct] = useState<number>(0);
  const [altDiscounts, setAltDiscounts] = useState<Record<string, number>>({});

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

  // Find SKU id + produto_id + base_id for this omie product
  const { data: skuInfo, isLoading: loadingSku } = useQuery({
    queryKey: ['tint-sku-for-product', product.id],
    staleTime: 5 * 60 * 1000,
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase
        .from('tint_skus')
        .select('id, produto_id, base_id')
        .eq('omie_product_id', product.id)
        .eq('account', 'oben')
        .limit(1)
        .maybeSingle();
      return data || null;
    },
  });
  const skuId = skuInfo?.id || null;

  // Search formulas
  const { data: formulas, isLoading: loadingFormulas } = useQuery({
    queryKey: ['tint-formula-search', skuId, debouncedSearch],
    staleTime: 5 * 60 * 1000,
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

  // Pricing breakdown for selected formula (for informational display)
  const { data: pricing, isLoading: loadingPricing } = useTintPricing(selectedFormula?.id || null);

  // Last practiced price for this color+base for the customer
  const { data: lastPracticedPrice, isLoading: loadingLastPrice } = useQuery({
    queryKey: ['tint-last-price', customerUserId, product.id, selectedFormula?.cor_id],
    staleTime: 30 * 1000,
    enabled: !!customerUserId && !!selectedFormula?.cor_id && !!product.id,
    queryFn: async () => {
      if (!customerUserId || !selectedFormula?.cor_id || !product.id) return null;

      const { data: orders } = await supabase
        .from('sales_orders')
        .select('items, created_at')
        .eq('customer_user_id', customerUserId)
        .eq('account', 'oben')
        .order('created_at', { ascending: false })
        .limit(50);

      if (!orders) return null;

      for (const order of orders) {
        const items = order.items as any[];
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          if (
            item.product_id === product.id &&
            item.tint_cor_id === selectedFormula.cor_id
          ) {
            return {
              price: item.valor_unitario as number,
              date: order.created_at as string,
            };
          }
        }
      }
      return null;
    },
  });

  // Alternative packagings: same color, different SKUs
  const { data: alternatives, isLoading: loadingAlternatives } = useQuery({
    queryKey: ['tint-alternatives', selectedFormula?.cor_id, skuId],
    staleTime: 5 * 60 * 1000,
    enabled: !!selectedFormula?.cor_id && !!skuId,
    queryFn: async (): Promise<AlternativePackaging[]> => {
      if (!selectedFormula?.cor_id || !skuId) return [];

      // Get all formulas with the same cor_id but different sku_id
      const { data: altFormulas } = await supabase
        .from('tint_formulas')
        .select('id, sku_id, preco_final_sayersystem')
        .eq('account', 'oben')
        .eq('cor_id', selectedFormula.cor_id)
        .neq('sku_id', skuId)
        .not('sku_id', 'is', null);

      if (!altFormulas || altFormulas.length === 0) return [];

      // Get SKU details with omie_product_id
      const skuIds = [...new Set(altFormulas.map(f => f.sku_id!))];
      const { data: skus } = await supabase
        .from('tint_skus')
        .select('id, omie_product_id')
        .in('id', skuIds)
        .not('omie_product_id', 'is', null);

      if (!skus || skus.length === 0) return [];

      // Get product details
      const productIds = skus.map(s => s.omie_product_id!).filter(Boolean);
      const { data: products } = await supabase
        .from('omie_products')
        .select('id, codigo, descricao, unidade, valor_unitario, estoque, ativo, omie_codigo_produto, account, is_tintometric, tint_type')
        .in('id', productIds);

      if (!products) return [];

      const result: AlternativePackaging[] = [];
      for (const af of altFormulas) {
        const sku = skus.find(s => s.id === af.sku_id);
        if (!sku?.omie_product_id) continue;
        const prod = products.find(p => p.id === sku.omie_product_id);
        if (!prod) continue;

        result.push({
          formulaId: af.id,
          skuId: af.sku_id!,
          omieProductId: sku.omie_product_id,
          productDescricao: prod.descricao,
          productCodigo: prod.codigo,
          precoFinalCsv: af.preco_final_sayersystem ? Math.ceil(af.preco_final_sayersystem * 10) / 10 : af.preco_final_sayersystem,
          product: prod as Product,
        });
      }
      return result;
    },
  });

  // Use CSV price rounded up to the nearest R$0.10
  const rawCsv = selectedFormula?.preco_final_sayersystem ?? 0;
  const precoCsv = rawCsv > 0 ? Math.ceil(rawCsv * 10) / 10 : 0;
  const custoCorantes = pricing?.custoCorantes || 0;

  // Price priority: last practiced > CSV > calculated fallback
  const precoBase = product.valor_unitario;
  const precoCalculado = precoBase + custoCorantes;
  const precoSemDesconto = lastPracticedPrice?.price ?? (precoCsv > 0 ? precoCsv : precoCalculado);
  const precoFinal = discountPct > 0 ? Math.round(precoSemDesconto * (1 - discountPct / 100) * 100) / 100 : precoSemDesconto;

  const priceSource = lastPracticedPrice
    ? 'cliente'
    : precoCsv > 0
      ? 'csv'
      : 'calculado';

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

                  {/* Last practiced price for this customer */}
                  {loadingLastPrice ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : lastPracticedPrice ? (
                    <div className="flex items-center gap-2 p-2 rounded-md bg-primary/5 border border-primary/20">
                      <History className="w-3.5 h-3.5 text-primary shrink-0" />
                      <div className="text-xs">
                        <span className="font-medium text-primary">Último preço cliente: {fmt(lastPracticedPrice.price)}</span>
                        <span className="text-muted-foreground ml-1">
                          ({new Date(lastPracticedPrice.date).toLocaleDateString('pt-BR')})
                        </span>
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
                          {priceSource === 'cliente' ? 'Preço cliente' : priceSource === 'csv' ? 'Tabela CSV' : 'Calculado'}
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
                        {alternatives.map(alt => {
                          const altBasePrice = alt.precoFinalCsv && alt.precoFinalCsv > 0
                            ? alt.precoFinalCsv
                            : alt.product.valor_unitario + custoCorantes;
                          const altDisc = altDiscounts[alt.formulaId] || 0;
                          const altPrice = altDisc > 0 ? Math.round(altBasePrice * (1 - altDisc / 100) * 100) / 100 : altBasePrice;
                          return (
                            <div key={alt.formulaId} className="rounded-md border border-border hover:border-primary/50 transition-all text-xs group">
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
                                    <Badge variant="secondary" className="text-[8px] px-1 py-0 ml-1">CSV</Badge>
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
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
