import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  ShoppingCart, Plus, Minus, Trash2, Building2, Scissors,
} from 'lucide-react';
import { useMemo } from 'react';
import { DELIVERY_OPTIONS, TIME_SLOTS, DeliveryOption } from '@/types';
import type { ProductCartItem, ServiceCartItem } from '@/hooks/useUnifiedOrder';
import { fmt, getToolName } from '@/hooks/useUnifiedOrder';
import { usePrecoCockpit, chaveCockpit, type ItemCockpitInput, type LinhaCockpit } from '@/hooks/usePrecoCockpit';
import { FAIXA_UI } from '@/lib/preco/faixa-ui';
import { cn } from '@/lib/utils';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { useReguaPreco } from '@/hooks/useReguaPreco';
import { ReguaPrecoSinal } from '@/components/regua-preco/ReguaPrecoSinal';
import type { ReguaCartItem } from '@/lib/regua-preco/regua-preco-ui';
import { useReguaPrecoLog } from '@/hooks/useReguaPrecoLog';
import { isInvalidProductPrice } from '@/services/orderSubmission/priceGuard';

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
  customerUserId: string | null;
  customerName: string | null;
}

export function CartItemList({
  cart, obenProductItems, colacorProductItems, serviceItems,
  obenSubtotal, colacorProdSubtotal, serviceSubtotal, totalEstimated,
  deliveryOption, selectedTimeSlot,
  onUpdateQuantity, onUpdateProductPrice, onRemoveFromCart,
  getServicePrice, getCartIndex,
  customerUserId, customerName,
}: CartItemListProps) {
  // #6 (B): faixa do cockpit na linha do carrinho — aqui o tint_formula_id existe,
  // então a linha tinta recebe o custo REAL (base+corantes); item normal usa o preço
  // negociado. Chave composta (tint repete codigo por cor).
  const cockpitItens = useMemo<ItemCockpitInput[]>(() =>
    [...obenProductItems, ...colacorProductItems]
      .map(it => ({
        empresa: it.product.account ?? '',
        codigo: it.product.omie_codigo_produto,
        preco: it.unit_price,
        tint_formula_id: it.tint_formula_id ?? null,
      }))
      .filter(i => i.preco > 0 && Number.isFinite(i.codigo) && i.empresa !== ''),
    [obenProductItems, colacorProductItems],
  );
  const { data: cockpitList } = usePrecoCockpit(cockpitItens);
  const cockpitByKey = useMemo(() => {
    const m = new Map<string, LinhaCockpit>();
    cockpitItens.forEach((inp, i) => {
      const l = cockpitList?.[i];
      if (l) m.set(chaveCockpit(inp.empresa, inp.codigo, inp.tint_formula_id), l);
    });
    return m;
  }, [cockpitItens, cockpitList]);

  // Régua de Preço (v1 só Oben): sinal de mercado/piso-MC por linha. A Régua é a
  // autoridade do vermelho de margem — quando abaixoPiso, o badge do cockpit recua a neutro.
  const [reguaFlag] = useFeatureFlag('regua_preco_carrinho');
  const reguaItens = useMemo<ReguaCartItem[]>(() =>
    obenProductItems
      // Tinta tem custo formula-aware (base + corantes); a RPC da Régua só conhece o
      // product.id da BASE → piso de MC subestimado (Codex P1). v1 exclui tinta — o
      // cockpit, que é formula-aware, segue cobrindo. Incluir quando a RPC somar corantes.
      .filter((it) => !it.tint_formula_id)
      .map((it) => ({
        chave: chaveCockpit(it.product.account ?? '', it.product.omie_codigo_produto, it.tint_formula_id),
        productId: it.product.id,
        qty: it.quantity,
        precoAtual: it.unit_price,
      })),
    [obenProductItems],
  );
  const { reguaByKey } = useReguaPreco(reguaItens, customerUserId, reguaFlag);
  const { marcarExibido, marcarAplicado } = useReguaPrecoLog();

  const renderProductGroup = (items: ProductCartItem[], label: string, icon: React.ReactNode) => (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
        {icon}{label}
      </p>
      {items.map(item => {
        const cartIdx = getCartIndex(item);
        const chave = chaveCockpit(item.product.account ?? '', item.product.omie_codigo_produto, item.tint_formula_id);
        const health = cockpitByKey.get(chave);
        const regua = reguaByKey.get(chave);
        const reguaVermelho = regua?.sinal === 'piso'; // Régua = autoridade do vermelho de margem
        // Só suprime o vermelho FORTE do cockpit quando a Régua tem piso CONFIÁVEL (com
        // botão). Piso por CMC proxy (precoReferencia null) NÃO esconde o cockpit (Codex P1/P2).
        const cockpitSuprimido = reguaVermelho && regua?.precoReferencia != null && health?.faixa === 'vermelho';
        const invalidPrice = isInvalidProductPrice(item.unit_price);
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
                {((health && health.faixa !== 'neutro' && FAIXA_UI[health.faixa]) || regua) && (
                  <div className="mt-0.5 flex items-center gap-1 flex-wrap">
                    {health && health.faixa !== 'neutro' && FAIXA_UI[health.faixa] && (
                      <Badge
                        variant="outline"
                        className={cn('text-[9px] px-1 py-0', cockpitSuprimido ? 'text-muted-foreground border-border' : FAIXA_UI[health.faixa].cls)}
                        title={health.cmc != null ? 'Markup bruto sobre o custo (CMC) — não inclui imposto/comissão/frete/prazo' : undefined}
                      >
                        {cockpitSuprimido ? '' : FAIXA_UI[health.faixa].label}
                        {health.cmc != null && health.markup_perc != null && (
                          <span className={cn('font-mono', !cockpitSuprimido && 'ml-1')}>
                            {Math.round(health.markup_perc)}%{health.folga_reais != null ? ` · ${fmt(health.folga_reais)}` : ''}
                          </span>
                        )}
                      </Badge>
                    )}
                    {regua && (
                      <ReguaPrecoSinal
                        result={regua}
                        precoAtual={item.unit_price}
                        contexto={{ produto: item.product.descricao, cliente: customerName, qty: item.quantity }}
                        onExibido={(r) => marcarExibido(chave, {
                          account: 'oben', customerUserId: customerUserId!, productId: item.product.id,
                          quantity: item.quantity, precoAtual: item.unit_price,
                          cmcUsado: health?.cmc ?? null, result: r,
                        })}
                        onAplicar={(preco) => { onUpdateProductPrice(cartIdx, preco); marcarAplicado(chave, customerUserId!, preco); }}
                      />
                    )}
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
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  min={1}
                  value={item.quantity}
                  onFocus={e => e.target.select()}
                  onChange={e => {
                    const newQty = parseInt(e.target.value) || 1;
                    const delta = newQty - item.quantity;
                    if (delta !== 0) onUpdateQuantity(cartIdx, delta);
                  }}
                  className="h-6 w-12 text-xs text-center p-0"
                />
                <Button size="sm" variant="outline" className="h-6 w-6 p-0" onClick={() => onUpdateQuantity(cartIdx, 1)}>
                  <Plus className="w-3 h-3" />
                </Button>
              </div>
              <div className="flex items-center gap-0.5 flex-1">
                <span className="text-[10px] text-muted-foreground">R$</span>
                <Input type="text" inputMode="decimal" pattern="[0-9]*\.?[0-9]*" value={item.unit_price} aria-invalid={invalidPrice} onFocus={e => e.target.select()} onChange={e => onUpdateProductPrice(cartIdx, parseFloat(e.target.value) || 0)} className={cn('h-6 text-xs', invalidPrice && 'border-status-error focus-visible:ring-status-error')} />
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
