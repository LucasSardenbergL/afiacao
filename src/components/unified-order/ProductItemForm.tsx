import { useState, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Search, Plus, Loader2, Package, FileText } from 'lucide-react';
import { keyDeSku, type CurrentSpec } from '@/lib/knowledge-base/spec-link';
import { FichaTecnicaSheet } from '@/components/unified-order/FichaTecnicaSheet';
import { usePrecoCockpit, type ItemCockpitInput } from '@/hooks/usePrecoCockpit';
import { FAIXA_UI } from '@/lib/preco/faixa-ui';
import { cn } from '@/lib/utils';
import type { Product, ProductCartItem } from '@/hooks/useUnifiedOrder';
import { fmt } from '@/hooks/useUnifiedOrder';
import { format } from 'date-fns';

interface ProductItemFormProps {
  title: string;
  products: Product[];
  prices: Record<number, number>;
  loading: boolean;
  productSearch: string;
  onSearchChange: (v: string) => void;
  productItems: ProductCartItem[];
  onAddProduct: (p: Product, qty?: number) => void;
  customerPurchaseHistory?: Record<string, string>;
  /** True enquanto os preços do contrato do cliente ainda estão carregando
   *  (logo após selecionar o cliente). Mostra que os valores exibidos são de
   *  tabela e ainda vão atualizar — evita a percepção de "travado". */
  customerPricesLoading?: boolean;
  /** Mapa de fichas técnicas por keyDeSku(account, cod). Só vínculos confirmados+aprovados. */
  specsByKey?: Map<string, CurrentSpec>;
  /** Mostra "Ver ficha" só p/ staff (a view RLS já é staff; isto evita o affordance p/ não-staff). */
  canSeeFicha?: boolean;
}

export function ProductItemForm({
  title, products, prices, loading, productSearch, onSearchChange,
  productItems, onAddProduct, customerPurchaseHistory = {},
  customerPricesLoading = false, specsByKey, canSeeFicha = false,
}: ProductItemFormProps) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [fichaAberta, setFichaAberta] = useState<string | null>(null);

  // Cockpit de preço por linha (batch). Enquanto os preços do contrato carregam,
  // não consulta (o preço exibido ainda vai mudar). Saúde sobre o preço aplicado.
  const cockpitInputs = useMemo<ItemCockpitInput[]>(() => {
    if (customerPricesLoading) return [];
    // #6: produto tintométrico NÃO recebe faixa na lista — a faixa real (custo
    // base+corantes) depende da cor escolhida e aparece na linha do carrinho.
    // O custo da base aqui enganaria. Filtra fora os tintométricos.
    return products
      .filter(p => !p.is_tintometric)
      .map(p => ({ empresa: p.account ?? '', codigo: p.omie_codigo_produto, preco: prices[p.omie_codigo_produto] || p.valor_unitario }))
      .filter(i => i.preco > 0 && Number.isFinite(i.codigo) && i.empresa !== '');
  }, [products, prices, customerPricesLoading]);
  const { data: cockpitList } = usePrecoCockpit(cockpitInputs);
  // produtos da busca são únicos por código (e tint é filtrado fora) → Map por código.
  const cockpitByCode = useMemo(
    () => new Map((cockpitList ?? []).map(l => [l.codigo, l])),
    [cockpitList],
  );

  const getQty = (id: string) => quantities[id] ?? 1;
  const setQty = (id: string, v: number) => setQuantities(prev => ({ ...prev, [id]: Math.max(1, v) }));

  const formatDate = (dateStr: string) => {
    try {
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr;
      return format(new Date(dateStr), 'dd/MM/yyyy');
    } catch {
      return '';
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Package className="w-4 h-4" /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Buscar produto..." value={productSearch} onChange={e => onSearchChange(e.target.value)} className="pl-9 h-9" />
        </div>
        {customerPricesLoading && (
          <div className="flex items-center gap-1.5 mb-2 text-[11px] text-muted-foreground" role="status">
            <Loader2 className="w-3 h-3 animate-spin" /> Carregando preços do contrato…
          </div>
        )}
        {loading ? (
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        ) : (
          <div className="max-h-[400px] overflow-y-auto space-y-1">
            {products.map(product => {
              const isInCart = productItems.some(c => c.product.id === product.id);
              const customerPrice = prices[product.omie_codigo_produto];
              const lastOrderDate = customerPurchaseHistory[product.codigo] || customerPurchaseHistory[`pid:${product.id}`] || customerPurchaseHistory[`omie:${product.omie_codigo_produto}`] || '';
              const qty = getQty(product.id);
              const ficha = canSeeFicha
                ? specsByKey?.get(keyDeSku(product.account, product.omie_codigo_produto))
                : undefined;
              const health = cockpitByCode?.get(product.omie_codigo_produto);
              return (
                <div
                  key={product.id}
                  className={cn(
                    'rounded-lg border p-2 hover:bg-muted/20 transition-colors',
                    isInCart && 'bg-accent/20 border-accent'
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{product.descricao}</p>
                      <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                        <span className="text-[10px] text-muted-foreground font-mono">{product.codigo}</span>
                        {!product.ativo && <Badge variant="destructive" className="text-[9px] px-1 py-0">Inativo</Badge>}
                        {product.is_tintometric && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 border-primary/40 text-primary">🎨 Tintométrico</Badge>
                        )}
                        {customerPrice && customerPrice !== product.valor_unitario && (
                          <Badge variant="secondary" className="text-[9px] px-1 py-0">Preço cliente</Badge>
                        )}
                        {lastOrderDate && (
                          <span className="text-[9px] text-status-success">
                            {formatDate(lastOrderDate)}
                          </span>
                        )}
                        {health && health.faixa !== 'neutro' && FAIXA_UI[health.faixa] && (
                          <Badge
                            variant="outline"
                            className={cn('text-[9px] px-1 py-0', FAIXA_UI[health.faixa].cls)}
                            title={health.cmc != null ? 'Markup bruto sobre o custo (CMC) — não inclui imposto/comissão/frete/prazo' : undefined}
                          >
                            {FAIXA_UI[health.faixa].label}
                            {health.cmc != null && health.markup_perc != null && (
                              <span className="ml-1 font-mono">
                                {Math.round(health.markup_perc)}%{health.folga_reais != null ? ` · ${fmt(health.folga_reais)}` : ''}
                              </span>
                            )}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-semibold">{fmt(customerPrice || product.valor_unitario)}</p>
                      <Badge variant={product.estoque > 0 ? 'outline' : 'destructive'} className="text-[9px] mt-0.5">
                        Est: {product.estoque ?? 0}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-muted-foreground">Qtd:</span>
                      <Input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        min={1}
                        value={qty}
                        onFocus={e => e.target.select()}
                        onChange={e => setQty(product.id, parseInt(e.target.value) || 1)}
                        className="h-7 w-16 text-xs text-center"
                      />
                    </div>
                    {ficha && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1 text-primary shrink-0"
                        onClick={() => setFichaAberta(product.id)}
                      >
                        <FileText className="w-3 h-3" /> Ficha
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={isInCart ? 'secondary' : 'default'}
                      className="h-7 text-xs flex-1"
                      disabled={!product.ativo}
                      onClick={() => {
                        // Inativo no Omie era só badge — continuava adicionável
                        // e o pedido iria com item desativado (retroativo Codex).
                        if (!product.ativo) return;
                        onAddProduct(product, qty);
                        setQty(product.id, 1);
                      }}
                    >
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      {isInCart ? 'Adicionar +' : 'Adicionar'}
                    </Button>
                  </div>
                  {ficha && (
                    <FichaTecnicaSheet
                      spec={ficha}
                      open={fichaAberta === product.id}
                      onOpenChange={(o) => setFichaAberta(o ? product.id : null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}