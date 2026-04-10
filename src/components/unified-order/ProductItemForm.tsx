import { useState, useCallback, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Search, Plus, Loader2, Package } from 'lucide-react';
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
}

export function ProductItemForm({
  title, products, prices, loading, productSearch, onSearchChange,
  productItems, onAddProduct, customerPurchaseHistory = {},
}: ProductItemFormProps) {
  const [quantities, setQuantities] = useState<Record<string, number>>({});

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
        {loading ? (
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        ) : (
          <div className="max-h-[400px] overflow-y-auto space-y-1">
            {products.map(product => {
              const isInCart = productItems.some(c => c.product.id === product.id);
              const customerPrice = prices[product.omie_codigo_produto];
              const lastOrderDate = customerPurchaseHistory[product.codigo] || customerPurchaseHistory[`pid:${product.id}`] || customerPurchaseHistory[`omie:${product.omie_codigo_produto}`] || '';
              const qty = getQty(product.id);
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
                        {(product as any).is_tintometric && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 border-primary/40 text-primary">🎨 Tintométrico</Badge>
                        )}
                        {customerPrice && customerPrice !== product.valor_unitario && (
                          <Badge variant="secondary" className="text-[9px] px-1 py-0">Preço cliente</Badge>
                        )}
                        {lastOrderDate && (
                          <span className="text-[9px] text-green-700 dark:text-green-400">
                            {formatDate(lastOrderDate)}
                          </span>
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
                        type="number"
                        min={1}
                        value={qty}
                        onChange={e => setQty(product.id, parseInt(e.target.value) || 1)}
                        className="h-7 w-16 text-xs text-center"
                      />
                    </div>
                    <Button
                      size="sm"
                      variant={isInCart ? 'secondary' : 'default'}
                      className="h-7 text-xs flex-1"
                      onClick={() => {
                        onAddProduct(product, qty);
                        setQty(product.id, 1);
                      }}
                    >
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      {isInCart ? 'Adicionar +' : 'Adicionar'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}