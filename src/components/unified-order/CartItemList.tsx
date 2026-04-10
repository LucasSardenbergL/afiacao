import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  ShoppingCart, Plus, Minus, Trash2, Building2, Scissors,
} from 'lucide-react';
import { DELIVERY_OPTIONS, TIME_SLOTS, DeliveryOption } from '@/types';
import type { ProductCartItem, ServiceCartItem } from '@/hooks/useUnifiedOrder';
import { fmt, getToolName } from '@/hooks/useUnifiedOrder';

interface CartItemListProps {
  cart: { length: number };
  obenProductItems: ProductCartItem[];
  colacorProductItems: ProductCartItem[];
  serviceItems: ServiceCartItem[];
  obenSubtotal: number;
  colacorProdSubtotal: number;
  serviceSubtotal: number;
  totalEstimated: number;
  deliveryOption: DeliveryOption;
  selectedTimeSlot: string;
  onUpdateQuantity: (idx: number, delta: number) => void;
  onUpdateProductPrice: (idx: number, price: number) => void;
  onRemoveFromCart: (idx: number) => void;
  getServicePrice: (item: ServiceCartItem) => number | null;
  getCartIndex: (item: ProductCartItem | ServiceCartItem) => number;
}

export function CartItemList({
  cart, obenProductItems, colacorProductItems, serviceItems,
  obenSubtotal, colacorProdSubtotal, serviceSubtotal, totalEstimated,
  deliveryOption, selectedTimeSlot,
  onUpdateQuantity, onUpdateProductPrice, onRemoveFromCart,
  getServicePrice, getCartIndex,
}: CartItemListProps) {
  const renderProductGroup = (items: ProductCartItem[], label: string, icon: React.ReactNode) => (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
        {icon}{label}
      </p>
      {items.map(item => {
        const cartIdx = getCartIndex(item);
        return (
          <div key={`${item.product.id}-${item.tint_formula_id || 'base'}`} className="space-y-1.5 mb-2">
            <div className="flex items-start justify-between gap-1.5">
              <div className="flex-1">
                <p className="text-xs font-medium leading-tight">{item.product.descricao}</p>
                {item.tint_cor_id && (
                  <div className="flex items-center gap-1 mt-0.5">
                    <Badge variant="outline" className="text-[9px] px-1 py-0 border-primary/40 text-primary">
                      🎨 {item.tint_cor_id} — {item.tint_nome_cor}
                    </Badge>
                  </div>
                )}
              </div>
              <button onClick={() => onRemoveFromCart(cartIdx)}>
                <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-0.5">
                <Button size="sm" variant="outline" className="h-6 w-6 p-0" onClick={() => onUpdateQuantity(cartIdx, -1)}>
                  <Minus className="w-3 h-3" />
                </Button>
                <span className="text-xs w-6 text-center font-medium">{item.quantity}</span>
                <Button size="sm" variant="outline" className="h-6 w-6 p-0" onClick={() => onUpdateQuantity(cartIdx, 1)}>
                  <Plus className="w-3 h-3" />
                </Button>
              </div>
              <div className="flex items-center gap-0.5 flex-1">
                <span className="text-[10px] text-muted-foreground">R$</span>
                <Input type="number" step="0.01" value={item.unit_price} onFocus={e => e.target.select()} onChange={e => onUpdateProductPrice(cartIdx, parseFloat(e.target.value) || 0)} className="h-6 text-xs" />
              </div>
              <span className="text-xs font-semibold shrink-0">{fmt(item.quantity * item.unit_price)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <Card className="flex flex-col max-h-[50vh] overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShoppingCart className="w-4 h-4" />
          Carrinho
          {cart.length > 0 && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{cart.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-y-auto flex-1 min-h-0">
        {cart.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">Nenhum item adicionado</p>
        ) : (
          <div className="space-y-3">
            {obenProductItems.length > 0 && renderProductGroup(obenProductItems, 'Oben', <Building2 className="w-3 h-3 inline mr-1" />)}

            {colacorProductItems.length > 0 && (
              <>
                {obenProductItems.length > 0 && <Separator className="my-2" />}
                {renderProductGroup(colacorProductItems, 'Colacor Produtos', <Building2 className="w-3 h-3 inline mr-1" />)}
              </>
            )}

            {serviceItems.length > 0 && (
              <div>
                {(obenProductItems.length > 0 || colacorProductItems.length > 0) && <Separator className="my-2" />}
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  <Scissors className="w-3 h-3 inline mr-1" />Afiação
                </p>
                {serviceItems.map(item => {
                  const price = getServicePrice(item);
                  return (
                    <div key={item.userTool.id} className="mb-1.5">
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">{getToolName(item.userTool)}</p>
                          <p className="text-[10px] text-muted-foreground truncate">
                            {item.quantity}x {item.servico?.descricao || 'Selecione serviço'}
                          </p>
                          {item.notes && <p className="text-[10px] text-muted-foreground italic truncate">Obs: {item.notes}</p>}
                        </div>
                        {price !== null ? (
                          <span className="text-xs font-semibold shrink-0">{fmt(price * item.quantity)}</span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground italic shrink-0">A orçar</span>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div className="mt-1.5 pt-1.5 border-t border-dashed">
                  <p className="text-[10px] text-muted-foreground">
                    📦 {DELIVERY_OPTIONS[deliveryOption].label}
                    {deliveryOption !== 'balcao' && selectedTimeSlot && (
                      <> • {TIME_SLOTS.find(s => s.id === selectedTimeSlot)?.label}</>
                    )}
                  </p>
                </div>
              </div>
            )}

            <Separator />

            {obenProductItems.length > 0 && (
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Oben</span>
                <span className="font-medium">{fmt(obenSubtotal)}</span>
              </div>
            )}
            {colacorProductItems.length > 0 && (
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Colacor Prod.</span>
                <span className="font-medium">{fmt(colacorProdSubtotal)}</span>
              </div>
            )}
            {serviceItems.length > 0 && (
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Afiação</span>
                <span className="font-medium">{serviceSubtotal > 0 ? fmt(serviceSubtotal) : 'A orçar'}</span>
              </div>
            )}
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold">Total</span>
              <span className="text-sm font-bold">{totalEstimated > 0 ? fmt(totalEstimated) : 'A definir'}</span>
            </div>

            <div className="flex flex-wrap gap-1">
              {obenProductItems.length > 0 && <Badge variant="outline" className="text-[9px]"><Building2 className="w-2.5 h-2.5 mr-0.5" />Oben</Badge>}
              {colacorProductItems.length > 0 && <Badge variant="outline" className="text-[9px]"><Building2 className="w-2.5 h-2.5 mr-0.5" />Colacor</Badge>}
              {serviceItems.length > 0 && <Badge variant="outline" className="text-[9px]"><Scissors className="w-2.5 h-2.5 mr-0.5" />Afiação</Badge>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
