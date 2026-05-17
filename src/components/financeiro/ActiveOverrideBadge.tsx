import { useCompany } from '@/contexts/CompanyContext';
import { usePeriodOverride } from '@/hooks/usePeriodOverride';
import { Badge } from '@/components/ui/badge';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expirado';
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function ActiveOverrideBadge() {
  const { activeCompany } = useCompany();
  const { activeOverride } = usePeriodOverride(activeCompany);
  const [, force] = useState(0);

  useEffect(() => {
    if (!activeOverride) return;
    const t = setInterval(() => force(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [activeOverride]);

  if (!activeOverride) return null;

  return (
    <Badge variant="destructive" className="gap-1.5">
      <ShieldAlert className="h-3 w-3" />
      Override {String(activeOverride.mes).padStart(2, '0')}/{activeOverride.ano} · {formatRemaining(activeOverride.expires_at)}
    </Badge>
  );
}
