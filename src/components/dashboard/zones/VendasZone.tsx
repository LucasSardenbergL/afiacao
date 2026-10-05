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
import { estadoDeLeitura, desatualizado } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';

export function VendasZone() {
  const meta = ZONE_META.vendas;
  const { persona } = useDashboardPersonaContext();
  const { kpis, topItems, isLoading, isError, refetch, isLive, status, fetchStatus } = useVendasZone();
  // Offline a query PAUSA, e pausa não é erro: sem cache ela nem chega a "carregando" (o corpo
  // vazio dizia "Sem orçamentos aguardando."); com cache o faturado velho ficava como se fosse de
  // agora. Erro com cache segue o card de erro (degradação integral, decidida no #2766).
  const leitura = { status, fetchStatus };
  const temDado = kpis.length > 0;
  const semRedeSemDado = estadoDeLeitura(leitura) === 'sem-rede' && !temDado;
  const velho = desatualizado(leitura, temDado);

  return (
    <CockpitCard>
      <CockpitCardHeader icon={meta.icon} title={meta.label} caption={meta.caption} isLive={isLive} />
      {isLoading && <CockpitCardSkeleton />}
      {isError && <CockpitCardError onRetry={() => refetch()} />}
      {semRedeSemDado && <AvisoLeituraFalhou oque="as vendas de hoje" estado="sem-rede" className="mx-4" />}
      {!isLoading && !isError && temDado && (
        <>
          <CockpitKpiRow kpis={kpis} />
          <CockpitTopList zone="vendas" items={topItems} emptyLabel="Sem orçamentos aguardando." />
          {velho && (
            <AvisoLeituraFalhou
              oque="as vendas mais recentes (os números acima são da última leitura)"
              estado={velho}
              className="mx-4"
            />
          )}
        </>
      )}
      <CockpitCardFooter zone="vendas" persona={persona} label="Abrir vendas" path={meta.cockpitPath} />
    </CockpitCard>
  );
}
