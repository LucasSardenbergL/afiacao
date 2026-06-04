import { cn } from '@/lib/utils';
import { formatSlaWait, slaNivelClasses, type SlaNivel } from '@/lib/whatsapp/sla-format';

export function SlaBadge({ minutos, nivel, className }: { minutos: number; nivel: SlaNivel; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium tabular-nums', slaNivelClasses(nivel), className)}>
      esperando há {formatSlaWait(minutos)}
    </span>
  );
}
