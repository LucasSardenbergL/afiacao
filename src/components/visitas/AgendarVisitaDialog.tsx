import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useVisitasAgendadas } from '@/hooks/useVisitasAgendadas';
import { hojeISO } from '@/lib/visitas/today';

export function AgendarVisitaDialog({
  customerUserId,
  customerName,
  trigger,
}: {
  customerUserId: string;
  customerName: string;
  trigger: React.ReactNode;
}) {
  const { agendar } = useVisitasAgendadas();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(hojeISO());
  const [notes, setNotes] = useState('');

  const submit = () => {
    agendar.mutate(
      { customerUserId, scheduledDate: date, notes: notes.trim() || undefined },
      { onSuccess: () => { setOpen(false); setNotes(''); setDate(hojeISO()); } },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agendar visita — {customerName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="vag-date">Data</Label>
            <Input id="vag-date" type="date" min={hojeISO()} value={date}
              onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="vag-notes">Motivo (opcional)</Label>
            <Textarea id="vag-notes" value={notes} maxLength={500}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Por que vale visitar esse cliente?" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button onClick={submit} disabled={agendar.isPending || !date}>
            {agendar.isPending ? 'Agendando…' : 'Agendar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
