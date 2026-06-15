// src/components/melhorias/MelhoriaStatusBadge.tsx
// Pílula de status de melhoria — compartilhada entre a página /melhorias e o
// popover "Minhas melhorias" do topo (fonte única das cores/labels de status).
import { cn } from '@/lib/utils';
import type { MelhoriaStatus } from '@/lib/melhorias/types';

const STATUS_LABEL: Record<MelhoriaStatus, string> = {
  aberto: 'Aberto',
  em_andamento: 'Em andamento',
  resolvido: 'Resolvido',
  descartado: 'Descartado',
};

const STATUS_CLASSES: Record<MelhoriaStatus, string> = {
  aberto: 'bg-status-info-bg text-status-info border-transparent',
  em_andamento: 'bg-status-warning-bg text-status-warning border-transparent',
  resolvido: 'bg-status-success-bg text-status-success border-transparent',
  descartado: 'bg-muted text-muted-foreground border-transparent',
};

export function MelhoriaStatusBadge({
  status,
  className,
}: {
  status: MelhoriaStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold',
        STATUS_CLASSES[status],
        className,
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
