// Dialog de check-out de visita do planejador de rotas.
// Extraído de src/pages/AdminRoutePlanner.tsx (god-component split).
// Presentational controlado: estado dos campos vive na página.
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function CheckoutDialog({
  open,
  onOpenChange,
  targetName,
  result,
  onResultChange,
  revenue,
  onRevenueChange,
  notes,
  onNotesChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetName: string | undefined;
  result: string;
  onResultChange: (value: string) => void;
  revenue: string;
  onRevenueChange: (value: string) => void;
  notes: string;
  onNotesChange: (value: string) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Check-out — {targetName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label>Resultado da visita *</Label>
            <Select value={result} onValueChange={onResultChange}>
              <SelectTrigger className="mt-1.5">
                <SelectValue placeholder="Selecione o resultado..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pedido_fechado">✅ Pedido fechado</SelectItem>
                <SelectItem value="interesse">🤔 Interesse</SelectItem>
                <SelectItem value="sem_interesse">❌ Sem interesse</SelectItem>
                <SelectItem value="ausente">🚫 Ausente</SelectItem>
                <SelectItem value="reagendar">📅 Reagendar</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {result === 'pedido_fechado' && (
            <div>
              <Label>Receita gerada (R$)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0,00"
                value={revenue}
                onChange={(e) => onRevenueChange(e.target.value)}
                className="mt-1.5"
              />
            </div>
          )}

          <div>
            <Label>Observações (opcional)</Label>
            <Textarea
              placeholder="Notas sobre a visita..."
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              className="mt-1.5 resize-none"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button disabled={!result} onClick={onConfirm}>
            Confirmar Check-out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
