import { Clock, PlayCircle, CheckCircle2 } from 'lucide-react';

export function CycleIndicator({ now }: { now: Date }) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const overrideUntil = 9 * 60 + 30; // 09:30
  const cutoff = 10 * 60; // 10:00

  if (minutes < overrideUntil) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-status-success/15 text-status-success border border-status-success/30 text-sm">
        <Clock className="w-4 h-4" />
        Janela de override aberta até 09:30
      </div>
    );
  }
  if (minutes < cutoff) {
    return (
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-status-warning/15 text-status-warning border border-status-warning/30 text-sm">
        <PlayCircle className="w-4 h-4" />
        Disparando em breve
      </div>
    );
  }
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-muted text-muted-foreground border text-sm">
      <CheckCircle2 className="w-4 h-4" />
      Ciclo finalizado
    </div>
  );
}
