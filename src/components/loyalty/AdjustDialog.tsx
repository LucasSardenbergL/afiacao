// Dialog de ajuste de pontos (adicionar/aprovar resgate).
// Extraído verbatim de src/pages/AdminLoyalty.tsx (god-component split).
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function AdjustDialog({
  open, onOpenChange, type, points, setPoints, description, setDescription, onSubmit, loading,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  type: 'earn' | 'redeem';
  points: string;
  setPoints: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  onSubmit: () => void;
  loading: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {type === 'earn' ? '➕ Adicionar Pontos' : '🎁 Aprovar Resgate'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-foreground">Pontos</label>
            <Input
              type="number"
              min="1"
              value={points}
              onChange={e => setPoints(e.target.value)}
              placeholder="Ex: 100"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">Descrição</label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={type === 'earn' ? 'Motivo do bônus...' : 'Recompensa resgatada...'}
              rows={2}
            />
          </div>
          <Button onClick={onSubmit} disabled={loading || !points} className="w-full">
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            {type === 'earn' ? 'Adicionar Pontos' : 'Aprovar Resgate'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
