import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useEstoqueZone } from '@/hooks/dashboard/useEstoqueZone';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';

export function EstoqueZone() {
  const meta = ZONE_META.estoque;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, erroTopo, isLoading, isError, refetch, isLive } = useEstoqueZone();

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          {/* Lista vazia por FALHA não é "Sem pendências de estoque.": a leitura não aconteceu. Com parte lida, mostra o
              que veio e avisa que falta. */}
          {(!erroTopo || topItems.length > 0) && (
            <CockpitTopList zone="estoque" items={topItems} emptyLabel="Sem pendências de estoque." />
          )}
          {erroTopo && (
            <AvisoLeituraFalhou oque="todas as pendências de estoque" estado="erro" className="mx-4" testId="aviso-topo-falhou" />
          )}
        </>
      )}
      <CockpitCardFooter zone="estoque" persona={persona} label="Abrir estoque" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
