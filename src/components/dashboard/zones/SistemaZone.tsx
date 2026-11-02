import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useSistemaZone } from '@/hooks/dashboard/useSistemaZone';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';

export function SistemaZone() {
  const meta = ZONE_META.sistema;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, erroAprovacoes, isLoading, isError, refetch, isLive } = useSistemaZone();

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          {/* Lista vazia por FALHA não é "Tudo em dia.": a leitura de pendências não aconteceu. */}
          {erroAprovacoes ? (
            <AvisoLeituraFalhou oque="as aprovações pendentes" estado="erro" className="mx-4" />
          ) : (
            <CockpitTopList zone="sistema" items={topItems} emptyLabel="Tudo em dia." />
          )}
        </>
      )}
      <CockpitCardFooter zone="sistema" persona={persona} label="Abrir aprovações" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
