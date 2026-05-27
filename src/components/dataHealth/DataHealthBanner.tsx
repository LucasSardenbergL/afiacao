import { AlertTriangle } from 'lucide-react';
import { useDataHealth } from '@/hooks/useDataHealth';
import { cn } from '@/lib/utils';

/** Banner inline não-bloqueante pra UMA fonte. Aparece pra qualquer staff que abra a tela. */
export function DataHealthBanner({ source }: { source: string }) {
  const { data } = useDataHealth();
  const check = data?.find(c => c.source === source);
  if (!check || check.status === 'ok') return null;

  const isBroken = check.status === 'broken' || check.status === 'unknown';
  return (
    <div className={cn(
      'flex items-start gap-2 rounded-md border px-3 py-2 text-sm mb-3',
      isBroken ? 'bg-status-error-bg border-status-error/30 text-status-error'
               : 'bg-status-warning-bg border-status-warning/30 text-status-warning',
    )}>
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>{check.message} — dado não confiável, não decida por aqui.</span>
    </div>
  );
}
