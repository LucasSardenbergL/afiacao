import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useEstoqueZone } from '@/hooks/dashboard/useEstoqueZone';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';

export function EstoqueZone() {
  const meta = ZONE_META.estoque;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, isLoading, isError, refetch, isLive } = useEstoqueZone();

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          <CockpitTopList zone="estoque" items={topItems} emptyLabel="Sem pendências de estoque." />
        </>
      )}
      <CockpitCardFooter zone="estoque" persona={persona} label="Abrir estoque" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
