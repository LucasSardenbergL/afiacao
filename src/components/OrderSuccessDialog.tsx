import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CheckCircle, Share2, Eye } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface OrderSuccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerName: string;
  items: Array<{ description: string; quantity: number; unitPrice: number }>;
  total: number;
  orderNumbers: string[];
  onViewOrder: () => void;
  onShare: () => void;
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
}: OrderSuccessDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle className="w-6 h-6 text-primary" />
            <DialogTitle>Pedido criado com sucesso!</DialogTitle>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">Cliente</p>
            <p className="font-medium">{customerName}</p>
          </div>

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

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
            Fechar
          </Button>
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
