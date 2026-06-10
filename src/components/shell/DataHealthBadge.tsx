import { useNavigate } from 'react-router-dom';
import { ShieldAlert, ShieldQuestion } from 'lucide-react';
import { useDataHealth } from '@/hooks/useDataHealth';
import { badgeLevel } from '@/lib/dataHealth/health-helpers';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

export function DataHealthBadge() {
  const navigate = useNavigate();
  const { isStaff } = useAuth();
  // Gate na QUERY, não só na UI: sem o `isStaff` aqui, cliente final executava
  // a RPC get_data_health (14 checks) a cada 2min mesmo sem ver o badge.
  const { data, isError } = useDataHealth(isStaff);

  if (!isStaff) return null;

  const level = isError ? 'red' : badgeLevel(data ?? []);
  if (level === 'green') return null; // verde não polui o topbar

  const cfg = {
    red: { Icon: ShieldAlert, cls: 'text-status-error', label: 'Saúde de dados: problema' },
    amber: { Icon: ShieldQuestion, cls: 'text-status-warning', label: 'Saúde de dados: atenção' },
  }[level];

  return (
    <button
      onClick={() => navigate('/gestao/saude-dados')}
      title={cfg.label}
      aria-label={cfg.label}
      className={cn('inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-accent', cfg.cls)}
    >
      <cfg.Icon className="h-4 w-4" />
    </button>
  );
}
