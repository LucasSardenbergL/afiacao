import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useReposicaoZone } from '@/hooks/dashboard/useReposicaoZone';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';

export function ReposicaoZone() {
  const meta = ZONE_META.reposicao;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, isLoading, isError, refetch, isLive } = useReposicaoZone();

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          <CockpitTopList zone="reposicao" items={topItems} emptyLabel="Sem alertas ativos." />
        </>
      )}
      <CockpitCardFooter zone="reposicao" persona={persona} label="Abrir reposição" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
