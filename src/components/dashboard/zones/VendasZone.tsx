import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useVendasZone } from '@/hooks/dashboard/useVendasZone';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';

export function VendasZone() {
  const meta = ZONE_META.vendas;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, isLoading, isError, refetch, isLive } = useVendasZone();

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          <CockpitTopList zone="vendas" items={topItems} emptyLabel="Sem orçamentos aguardando." />
        </>
      )}
      <CockpitCardFooter zone="vendas" persona={persona} label="Abrir vendas" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
