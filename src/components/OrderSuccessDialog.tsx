import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CheckCircle, Share2, Eye, Printer, ArrowLeft, ShieldAlert } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { openPrintOrder, type PrintOrderData } from '@/components/OrderPrintLayout';
import { formatBRL } from '@/lib/reposicao';
import type { BloqueioCreditoPedido } from '@/services/orderSubmission';

interface OrderSuccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerName: string;
  items: Array<{ description: string; quantity: number; unitPrice: number }>;
  total: number;
  orderNumbers: string[];
  onViewOrder: () => void;
  onShare: () => void;
  printDataList?: PrintOrderData[];
  returnTo?: string | null;
  onVoltarFila?: () => void;
  /** Contas travadas pela trava de crédito (Fase 2) — o PV NÃO foi criado no Omie. */
  bloqueiosCredito?: BloqueioCreditoPedido[];
  /** Abre o fluxo de exceção (gestor aprova / vendedor leva ao gestor). */
  onResolverBloqueio?: (b: BloqueioCreditoPedido) => void;
}

export function OrderSuccessDialog({
  open,
  onOpenChange,
  customerName,
  items,
  total,
  orderNumbers,
  onViewOrder,
  onShare,
  printDataList,
  returnTo,
  onVoltarFila,
  bloqueiosCredito,
  onResolverBloqueio,
}: OrderSuccessDialogProps) {
  const handlePrint = () => {
    if (!printDataList || printDataList.length === 0) return;
    // Open one print tab per company
    printDataList.forEach((data, i) => {
      setTimeout(() => openPrintOrder(data), i * 500);
    });
  };

  const temBloqueio = (bloqueiosCredito?.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-2">
            {temBloqueio ? (
              <ShieldAlert className="w-6 h-6 text-status-error" />
            ) : (
              <CheckCircle className="w-6 h-6 text-primary" />
            )}
            <DialogTitle>
              {temBloqueio ? 'Pedido salvo — envio bloqueado por crédito' : 'Pedido criado com sucesso!'}
            </DialogTitle>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">Cliente</p>
            <p className="font-medium">{customerName}</p>
          </div>

          {temBloqueio && (
            <div className="space-y-2">
              {bloqueiosCredito!.map((b) => (
                <div
                  key={b.salesOrderId}
                  className="bg-status-error/10 border border-status-error/30 rounded-lg p-3 text-xs space-y-2"
                  data-testid="bloqueio-credito-pedido"
                >
                  <p className="font-semibold text-status-error">
                    PV {b.account === 'oben' ? 'Oben' : 'Colacor'} NÃO criado no Omie
                    {typeof b.vencido === 'number' && (
                      <> — {formatBRL(b.vencido)} vencido há 60+ dias{b.titulos ? ` (${b.titulos} título${b.titulos > 1 ? 's' : ''})` : ''}</>
                    )}
                  </p>
                  <p className="text-muted-foreground">
                    O pedido ficou salvo. Um gestor pode aprovar uma exceção para ESTE pedido — depois é só reenviar.
                  </p>
                  {onResolverBloqueio && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => onResolverBloqueio(b)}
                    >
                      <ShieldAlert className="w-3.5 h-3.5" />
                      Exceção de crédito
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}

          {orderNumbers.length > 0 && (
            <div>
              <p className="text-sm text-muted-foreground">Número(s)</p>
              <p className="font-medium">{orderNumbers.join(' + ')}</p>
            </div>
          )}

          <div>
            <p className="text-sm text-muted-foreground mb-2">Itens ({items.length})</p>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {items.map((item, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {item.quantity}x {item.description}
                  </span>
                  <span className="font-medium">
                    {(item.quantity * item.unitPrice).toLocaleString('pt-BR', {
                      style: 'currency',
                      currency: 'BRL',
                    })}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="pt-3 border-t">
            <div className="flex justify-between items-center">
              <p className="font-semibold">Total</p>
              <p className="text-lg font-bold">
                {total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
              </p>
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            {format(new Date(), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2 flex-wrap">
          {returnTo && onVoltarFila && (
            <Button onClick={onVoltarFila} className="flex-1 gap-2">
              <ArrowLeft className="w-4 h-4" />
              Voltar pra fila
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
            Fechar
          </Button>
          {printDataList && printDataList.length > 0 && (
            <Button variant="secondary" onClick={handlePrint} className="flex-1 gap-2">
              <Printer className="w-4 h-4" />
              Imprimir ({printDataList.length})
            </Button>
          )}
          <Button variant="secondary" onClick={onViewOrder} className="flex-1 gap-2">
            <Eye className="w-4 h-4" />
            Ver pedido
          </Button>
          <Button onClick={onShare} className="flex-1 gap-2">
            <Share2 className="w-4 h-4" />
            WhatsApp
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
