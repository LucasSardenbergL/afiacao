// Dialog de registro de resultado pós-ligação.
// Extraído verbatim de src/pages/FarmerTacticalPlan.tsx (god-component split).
import { useState } from 'react';
import { Loader2, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import type { RecordResultPayload } from './types';

export const RecordResultDialog = ({
  planId,
  onRecord,
}: {
  planId: string;
  onRecord: (planId: string, result: RecordResultPayload) => Promise<void>;
}) => {
  // Lente "Ver como": registrar resultado é write (update) — desabilitado.
  const { isImpersonating } = useImpersonation();
  const [open, setOpen] = useState(false);
  const [planFollowed, setPlanFollowed] = useState(true);
  const [callResult, setCallResult] = useState('');
  const [actualMargin, setActualMargin] = useState('');
  const [duration, setDuration] = useState('');
  const [objectionType, setObjectionType] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await onRecord(planId, {
      planFollowed,
      callResult,
      actualMargin: parseFloat(actualMargin) || 0,
      callDurationSeconds: (parseFloat(duration) || 0) * 60,
      objectionType: objectionType || undefined,
      notes: notes || undefined,
    });
    setSaving(false);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="w-full text-[10px] gap-1"
          disabled={isImpersonating}
          title={isImpersonating ? 'Indisponível em modo Ver como' : undefined}
        >
          <FileText className="w-3 h-3" /> Registrar Resultado
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Resultado da Ligação</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Switch checked={planFollowed} onCheckedChange={setPlanFollowed} />
            <Label className="text-xs">Plano foi seguido</Label>
          </div>

          <Select value={callResult} onValueChange={setCallResult}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Resultado" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="venda_realizada" className="text-xs">Venda realizada</SelectItem>
              <SelectItem value="interesse_futuro" className="text-xs">Interesse futuro</SelectItem>
              <SelectItem value="sem_interesse" className="text-xs">Sem interesse</SelectItem>
              <SelectItem value="nao_atendeu" className="text-xs">Não atendeu</SelectItem>
              <SelectItem value="reagendado" className="text-xs">Reagendado</SelectItem>
            </SelectContent>
          </Select>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[10px]">Margem (R$)</Label>
              <Input type="number" value={actualMargin} onChange={e => setActualMargin(e.target.value)} className="h-8 text-xs" placeholder="0.00" />
            </div>
            <div>
              <Label className="text-[10px]">Duração (min)</Label>
              <Input type="number" value={duration} onChange={e => setDuration(e.target.value)} className="h-8 text-xs" placeholder="0" />
            </div>
          </div>

          <Select value={objectionType} onValueChange={setObjectionType}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Tipo de objeção (opcional)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="preco" className="text-xs">Preço</SelectItem>
              <SelectItem value="tecnica" className="text-xs">Técnica</SelectItem>
              <SelectItem value="urgencia" className="text-xs">Falta de urgência</SelectItem>
              <SelectItem value="concorrente" className="text-xs">Concorrente</SelectItem>
              <SelectItem value="nenhuma" className="text-xs">Nenhuma</SelectItem>
            </SelectContent>
          </Select>

          <Textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Observações..." className="text-xs min-h-[60px]" />

          <Button onClick={handleSave} disabled={!callResult || saving} className="w-full text-xs">
            {saving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Salvar Resultado
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
