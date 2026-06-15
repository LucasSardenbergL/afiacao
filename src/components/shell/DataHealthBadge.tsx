import { useNavigate } from 'react-router-dom';
import { ShieldAlert, ShieldQuestion } from 'lucide-react';
import { useDataHealth } from '@/hooks/useDataHealth';
import { badgeLevel } from '@/lib/dataHealth/health-helpers';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';
import { cn } from '@/lib/utils';

export function DataHealthBadge() {
  const navigate = useNavigate();
  // Saúde de dados é tarefa de quem ADMINISTRA o sistema (master/gestor), não de
  // qualquer funcionário: uma vendedora não tem o que fazer com "sync stale" nem
  // com a instrução de TI que a tela exibe ("rode sync_X no chat do Lovable").
  // Antes o gate era `isStaff` puro — aparecia até p/ vendedora sales-only, que
  // nem vê o item "Saúde de Dados" no menu (inconsistência). Lente-aware
  // (useDisplayAccess): some quando o master "vira" vendedora na lente.
  // Gate na QUERY também, não só na UI: sem ele, o employee executava a RPC
  // get_data_health (14 checks) a cada 2min sem ver o badge.
  const { displayIsMaster, displayIsGestorComercial } = useDisplayAccess();
  const podeVer = displayIsMaster || displayIsGestorComercial;
  const { data, isError } = useDataHealth(podeVer);

  if (!podeVer) return null;

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
