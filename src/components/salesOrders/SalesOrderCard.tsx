// Card de um pedido (venda ou afiação) na listagem.
// Extraído verbatim de src/pages/SalesOrders.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Trash2, Share2, Pencil, Printer } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { StatusBadgeSimple } from '@/components/StatusBadge';
import type { OrderStatus } from '@/types';
import { statusLabels, type SalesOrder } from './types';

interface SalesOrderCardProps {
  order: SalesOrder;
  customerName: string;
  checked: boolean;
  onSelectChange: (checked: boolean) => void;
  onShare: () => void;
  onDelete: () => void;
  onNavigate: (path: string) => void;
  onOpenDetail: () => void;
  onPrint: () => void;
}

export function SalesOrderCard({
  order,
  customerName,
  checked,
  onSelectChange,
  onShare,
  onDelete,
  onNavigate,
  onOpenDetail,
  onPrint,
}: SalesOrderCardProps) {
  const isAfiacao = order._source === 'afiacao';
  const status = statusLabels[order.status] || statusLabels.rascunho;
  const totalItems = order.items?.reduce((s, i) => s + (i.quantidade || 0), 0) || 0;
  // Afiação opera sob Colacor SC. Card sempre mostra a empresa (Oben/Colacor/SC)
  // e, quando for pedido de afiação, um badge secundário "Afiação" pra distinguir
  // serviço de pedido comercial. Antes mostrava só "Afiação" e perdia a empresa.
  const orderAccount = isAfiacao ? 'colacor_sc' : (order.account || 'oben');
  const accountLabel = orderAccount === 'colacor_sc'
    ? 'Colacor SC'
    : orderAccount === 'colacor'
      ? 'Colacor'
      : 'Oben';
  const isSelectable = !isAfiacao; // só sales_orders são bulk-deletáveis

  return (
    <Card className={`cursor-pointer hover:bg-muted/30 transition-colors ${checked ? 'ring-2 ring-foreground/20' : ''}`} onClick={() => (isAfiacao ? onNavigate(`/orders/${order.id}`) : onOpenDetail())}>
      <CardContent className="p-3">
        <div className="flex items-start justify-between gap-2">
          {isSelectable && (
            <Checkbox
              checked={checked}
              onClick={(e) => e.stopPropagation()}
              onCheckedChange={(v) => onSelectChange(!!v)}
              className="mt-0.5"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="font-medium text-sm truncate">
                {customerName}
              </p>
              <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                {accountLabel}
              </Badge>
              {/* Badge secundário pra distinguir serviço de afiação dentro de SC */}
              {isAfiacao && (
                <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0 bg-muted/50 text-muted-foreground border-dashed">
                  Afiação
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {format(new Date(order.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
            </p>
            {order.omie_numero_pedido && (
              <p className="text-xs text-muted-foreground">
                PV: <span className="font-tabular text-foreground">{order.omie_numero_pedido.replace(/^0+/, '') || '0'}</span>
              </p>
            )}
          </div>
          <div className="text-right shrink-0 space-y-1">
            {isAfiacao ? (
              <StatusBadgeSimple status={order.status as OrderStatus} size="sm" />
            ) : (
              <Badge variant={status.variant}>{status.label}</Badge>
            )}
            <p className="text-sm font-bold">R$ {order.total.toFixed(2)}</p>
            <p className="text-xs text-muted-foreground">{totalItems} itens</p>
            <div className="flex gap-1 justify-end">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={(e) => {
                  e.stopPropagation();
                  onShare();
                }}
                title="Compartilhar via WhatsApp"
              >
                <Share2 className="w-3.5 h-3.5" />
              </Button>
              {!isAfiacao && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPrint();
                  }}
                  title="Imprimir pedido"
                >
                  <Printer className="w-3.5 h-3.5" />
                </Button>
              )}
              {!isAfiacao && !['cancelado', 'entregue', 'faturado'].includes(order.status) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNavigate(`/sales/edit/${order.id}`);
                  }}
                  title="Editar pedido"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
              )}
              {!isAfiacao && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={(e) => e.stopPropagation()}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Excluir pedido?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Esta ação não pode ser desfeita. O pedido será removido permanentemente do sistema.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                      <AlertDialogAction onClick={onDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                        Excluir
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
