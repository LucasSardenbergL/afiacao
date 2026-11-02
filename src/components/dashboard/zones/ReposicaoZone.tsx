import { CockpitCard } from '../cockpit/CockpitCard';
import { CockpitCardHeader } from '../cockpit/CockpitCardHeader';
import { CockpitKpiRow } from '../cockpit/CockpitKpiRow';
import { CockpitTopList } from '../cockpit/CockpitTopList';
import { CockpitCardFooter } from '../cockpit/CockpitCardFooter';
import { CockpitCardError } from '../cockpit/CockpitCardError';
import { CockpitCardSkeleton } from '../cockpit/CockpitCardSkeleton';
import { useReposicaoZone } from '@/hooks/dashboard/useReposicaoZone';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { ZONE_META } from '@/lib/dashboard/zone-meta';
import { useDashboardPersonaContext } from '@/contexts/DashboardPersonaContext';

export function ReposicaoZone() {
  const meta = ZONE_META.reposicao;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, erroTopo, isLoading, isError, refetch, isLive } = useReposicaoZone();

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {!isLoading && !isError && (
        <>
          <CockpitKpiRow kpis={kpis} />
          {/* Lista vazia por FALHA não é "Sem alertas ativos.": a leitura não aconteceu. Com parte lida, mostra o
              que veio e avisa que falta. */}
          {(!erroTopo || topItems.length > 0) && (
            <CockpitTopList zone="reposicao" items={topItems} emptyLabel="Sem alertas ativos." />
          )}
          {erroTopo && (
            <AvisoLeituraFalhou oque="os alertas de reposição" estado="erro" className="mx-4" testId="aviso-topo-falhou" />
          )}
        </>
      )}
      <CockpitCardFooter zone="reposicao" persona={persona} label="Abrir reposição" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
