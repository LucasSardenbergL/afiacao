import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useFinanceiroZone } from '@/hooks/dashboard/useFinanceiroZone';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';

export function FinanceiroZone() {
  const meta = ZONE_META.financeiro;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, isLoading, isError, refetch, isLive } = useFinanceiroZone();

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          <CockpitTopList zone="financeiro" items={topItems} emptyLabel="Sem inadimplentes críticos." />
        </>
      )}
      <CockpitCardFooter zone="financeiro" persona={persona} label="Abrir financeiro" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
