import { Button } from '@/components/ui/button';
import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useTintometricoZone } from '@/hooks/dashboard/useTintometricoZone';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';
import { useCompany } from '@/contexts/CompanyContext';

export function TintometricoZone() {
  const meta = ZONE_META.tintometrico;
  const { persona } = useDashboardPersonaContext();
  const { setSelection } = useCompany();
  const { kpis, topItems, isLoading, isError, refetch, isLive, applies } = useTintometricoZone();

  if (!applies) {
    return (
      <CockpitCard>
        <CockpitCardHeader icon={meta.icon} title={meta.label} caption="Exclusivo Oben" isLive={false} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="text-xs text-muted-foreground">
            Tintométrico é exclusivo da Oben. Troque pra ver os dados.
          </p>
          <Button variant="outline" size="sm" onClick={() => setSelection('oben')}>
            Trocar pra Oben
          </Button>
        </div>
        <CockpitCardFooter zone="tintometrico" persona={persona} label="Abrir tintométrico" path={meta.cockpitPath} />
      </CockpitCard>
    );
  }

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          <CockpitTopList zone="tintometrico" items={topItems} emptyLabel="Sem erros recentes." />
        </>
      )}
      <CockpitCardFooter zone="tintometrico" persona={persona} label="Abrir tintométrico" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
