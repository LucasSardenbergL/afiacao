import { useState, useCallback } from 'react';
import { parsePostgresFinanceiroError } from '@/lib/financeiro/error-handler';
import { PeriodOverrideModal } from './PeriodOverrideModal';
import { toast } from 'sonner';

export function usePeriodLockHandler() {
  const [target, setTarget] = useState<{ company: string; ano: number; mes: number } | null>(null);

  const handle = useCallback((err: unknown): boolean => {
    const parsed = parsePostgresFinanceiroError(err);
    if (parsed.kind === 'period_locked') {
      const [mm, yyyy] = parsed.periodo.split('/');
      setTarget({ company: parsed.empresa, ano: Number(yyyy), mes: Number(mm) });
      toast.error(`Período ${parsed.periodo} fechado. Abrindo modal de override.`);
      return true;
    }
    return false;
  }, []);

  const modal = target ? (
    <PeriodOverrideModal
      open
      onOpenChange={(open) => !open && setTarget(null)}
      company={target.company}
      ano={target.ano}
      mes={target.mes}
      onOverrideOpened={() => setTarget(null)}
    />
  ) : null;

  return { handle, modal };
}
