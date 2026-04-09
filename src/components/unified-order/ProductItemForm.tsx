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
  onAddProduct: (p: Product) => void;
  customerPurchaseHistory?: Record<string, string>;
}

export function ProductItemForm({
  title, products, prices, loading, productSearch, onSearchChange,
  productItems, onAddProduct, customerPurchaseHistory = {},
}: ProductItemFormProps) {
  const [colWidth, setColWidth] = useState(450);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(200);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = colWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = ev.clientX - startX.current;
      setColWidth(Math.max(120, Math.min(500, startW.current + delta)));
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [colWidth]);

  const formatDate = (dateStr: string) => {
    try {
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
          <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
            <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: colWidth }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 70 }} />
                <col style={{ width: 40 }} />
              </colgroup>
              <thead className="sticky top-0 bg-card z-10">
                <tr className="border-b bg-muted/30">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground relative select-none">
                    Produto
                    <span
                      onMouseDown={onMouseDown}
                      className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 rounded-r"
                      title="Arrastar para redimensionar"
                    />
                  </th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground">Preço</th>
                  <th className="text-center px-3 py-2 font-medium text-muted-foreground">Estoque</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {products.map(product => {
                  const isInCart = productItems.some(c => c.product.id === product.id);
                  const customerPrice = prices[product.omie_codigo_produto];
                  const lastOrderDate = customerPurchaseHistory[product.codigo] || customerPurchaseHistory[`pid:${product.id}`];
                  const hasBoughtBefore = !!lastOrderDate || !!customerPrice;
                  return (
                    <tr key={product.id} className={cn('border-b last:border-b-0 hover:bg-muted/20 transition-colors', isInCart && 'bg-accent/20')}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs truncate" style={{ maxWidth: colWidth - 24 }}>{product.descricao}</span>
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
                        <span className="text-[10px] text-muted-foreground font-mono">{product.codigo}</span>
                      </td>
                      <td className="px-3 py-2 text-right text-xs font-medium">
                        {fmt(customerPrice || product.valor_unitario)}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <Badge variant={product.estoque > 0 ? 'outline' : 'destructive'} className="text-[10px]">
                          {product.estoque ?? 0}
                        </Badge>
                      </td>
                      <td className="px-2 py-2">
                        <Button size="sm" variant={isInCart ? 'secondary' : 'ghost'} className="h-7 w-7 p-0" onClick={() => onAddProduct(product)}>
                          <Plus className="w-3.5 h-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}