// Painel lateral (read-only) com o conteúdo de um pedido de venda.
// Abre ao clicar no card da listagem — ver itens/valores/observações sem sair
// da lista, e disparar Imprimir / Compartilhar / Editar.
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Printer, Share2, Pencil } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { statusLabels, type SalesOrder } from './types';
import { itemTotal } from './print';

interface SalesOrderDetailSheetProps {
  order: SalesOrder | null;
  customerName: string;
  onClose: () => void;
  onPrint: () => void;
  onShare: () => void;
  onEdit: () => void;
}

const fmt = (v: number) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Pedido cancelado/entregue/faturado não é editável (mesma regra do card).
const canEditStatus = (status: string) => !['cancelado', 'entregue', 'faturado'].includes(status);

export function SalesOrderDetailSheet({
  order,
  customerName,
  onClose,
  onPrint,
  onShare,
  onEdit,
}: SalesOrderDetailSheetProps) {
  const open = !!order;
  const status = order ? statusLabels[order.status] || statusLabels.rascunho : null;
  const accountLabel =
    order?.account === 'colacor_sc' ? 'Colacor SC' : order?.account === 'colacor' ? 'Colacor' : 'Oben';
  const pv = order?.omie_numero_pedido ? order.omie_numero_pedido.replace(/^0+/, '') || '0' : null;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto flex flex-col">
        {order && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2 flex-wrap text-base">
                <span className="truncate">{customerName}</span>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                  {accountLabel}
                </Badge>
                {status && (
                  <Badge variant={status.variant} className="shrink-0">
                    {status.label}
                  </Badge>
                )}
              </SheetTitle>
              <SheetDescription className="text-xs">
                {pv && (
                  <>
                    PV <span className="font-tabular text-foreground">{pv}</span>
                    {' · '}
                  </>
                )}
                {format(new Date(order.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 space-y-4 py-4">
              {/* Itens */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                  Itens ({order.items?.length || 0})
                </p>
                <div className="space-y-2">
                  {(order.items || []).map((item, i) => (
                    <div key={i} className="flex items-start justify-between gap-3 text-sm border-b border-border/50 pb-2 last:border-0">
                      <div className="min-w-0 flex-1">
                        <p className="truncate">{item.descricao || 'Item'}</p>
                        {item.tint_nome_cor && (
                          <p className="text-xs text-muted-foreground truncate">
                            🎨 {item.tint_cor_id} - {item.tint_nome_cor}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {item.quantidade} × {fmt(item.valor_unitario)}
                        </p>
                      </div>
                      <span className="font-medium tabular-nums shrink-0">{fmt(itemTotal(item))}</span>
                    </div>
                  ))}
                  {(order.items?.length || 0) === 0 && (
                    <p className="text-sm text-muted-foreground">Sem itens neste pedido.</p>
                  )}
                </div>
              </div>

              {/* Totais */}
              <div className="space-y-1 text-sm border-t border-border pt-3">
                <div className="flex justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="tabular-nums">{fmt(order.subtotal)}</span>
                </div>
                <div className="flex justify-between font-semibold text-base">
                  <span>Total</span>
                  <span className="tabular-nums">{fmt(order.total)}</span>
                </div>
              </div>

              {/* Observações */}
              {order.notes && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wide">
                    Observações
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{order.notes}</p>
                </div>
              )}
            </div>

            {/* Ações */}
            <div className="flex gap-2 border-t border-border pt-4">
              <Button onClick={onPrint} className="flex-1 gap-2">
                <Printer className="w-4 h-4" />
                Imprimir
              </Button>
              <Button variant="outline" onClick={onShare} className="gap-2">
                <Share2 className="w-4 h-4" />
                Compartilhar
              </Button>
              {canEditStatus(order.status) && (
                <Button variant="outline" onClick={onEdit} className="gap-2" title="Editar pedido">
                  <Pencil className="w-4 h-4" />
                </Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
