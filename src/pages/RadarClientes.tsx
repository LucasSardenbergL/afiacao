import { lazy, Suspense, useMemo, useState } from 'react';
import { Radar } from 'lucide-react';
import { useUrlState } from '@/hooks/useUrlState';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { useRadarLista, type RadarFiltros, type RadarEmpresa } from '@/queries/useRadarLista';
import { useRadarKpis } from '@/queries/useRadarKpis';
import { RadarKpis } from '@/components/radar/RadarKpis';
import { RadarFiltros as Filtros } from '@/components/radar/RadarFiltros';
import { RadarLinha } from '@/components/radar/RadarLinha';
import { RadarDetailSheet } from '@/components/radar/RadarDetailSheet';
import { RadarRankingCidades } from '@/components/radar/RadarRankingCidades';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import type { PresetRadar } from '@/lib/radar/ui-helpers';

const RadarMapa = lazy(() => import('@/components/radar/RadarMapa'));

// useUrlState exige um shape com index signature (Record<string, Primitive>).
// RadarFiltros é uma interface (sem index signature) e tem `preset` como union
// PresetRadar — incompatível direto com a restrição StateShape. Em vez de um
// duplo cast `as unknown`, usamos um tipo de transporte para a URL com `preset`
// alargado para `string` + index signature, e NARROW para RadarFiltros uma vez
// na fronteira (typecheck strict, sem `any`). O `set` resultante (Partial do
// transporte) é aceito onde se espera Partial<RadarFiltros> por contravariância
// (PresetRadar ⊆ string).
type RadarUrlState = {
  busca: string;
  uf: string;
  municipio: string;
  cnae: string;
  status: string;
  incluirJaClientes: boolean;
  comTelefone: boolean;
  preset: string;
  vista: string;
  [k: string]: string | boolean;
};

const DEFAULTS: RadarUrlState = {
  busca: '',
  uf: '',
  municipio: '',
  cnae: '',
  status: '',
  incluirJaClientes: false,
  comTelefone: false,
  preset: 'novas',
  vista: 'lista',
};

function narrowPreset(v: string): PresetRadar {
  return v === 'estabelecidas' ? 'estabelecidas' : 'novas';
}

export default function RadarClientes() {
  const [raw, set] = useUrlState<RadarUrlState>(DEFAULTS);
  const filtros: RadarFiltros = { ...raw, preset: narrowPreset(raw.preset) };

  const hojeISO = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  const q = useRadarLista(filtros, hojeISO);
  const kpis = useRadarKpis();
  const [aberta, setAberta] = useState<RadarEmpresa | null>(null);
  const sentinelRef = useInfiniteScroll(() => q.fetchNextPage(), !!q.hasNextPage && !q.isFetchingNextPage);

  const empresas = q.data?.pages.flat() ?? [];

  return (
    <div className="p-4 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center gap-2">
        <Radar className="w-5 h-5" />
        <h1 className="text-2xl font-display">Radar de Clientes</h1>
        {kpis.data?.lote && (
          <span className="ml-2 text-xs text-muted-foreground border rounded px-2 py-0.5">
            lote {kpis.data.lote}
          </span>
        )}
        <div className="ml-auto flex gap-1">
          <Button
            variant={raw.vista !== 'mapa' ? 'default' : 'outline'}
            size="sm"
            onClick={() => set({ vista: 'lista' })}
          >
            Lista
          </Button>
          <Button
            variant={raw.vista === 'mapa' ? 'default' : 'outline'}
            size="sm"
            onClick={() => set({ vista: 'mapa' })}
          >
            Mapa
          </Button>
        </div>
      </div>
      <RadarKpis />
      <Filtros filtros={filtros} set={set} />
      <RadarRankingCidades filtros={filtros} hojeISO={hojeISO} onPick={(nome) => set({ municipio: nome })} />

      {raw.vista === 'mapa' ? (
        <Suspense fallback={<Skeleton className="h-[420px]" />}>
          <RadarMapa
            filtros={filtros}
            hojeISO={hojeISO}
            onPick={(nome) => set({ municipio: nome, vista: 'lista' })}
          />
        </Suspense>
      ) : (
        <div className="rounded-md border">
          {q.isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : q.isError ? (
            <EmptyState
              tone="operational"
              icon={Radar}
              title="Não foi possível carregar"
              description="Tente novamente em instantes."
            />
          ) : empresas.length === 0 ? (
            <EmptyState
              tone="operational"
              icon={Radar}
              title="Nenhuma empresa nesta fila"
              description="Ajuste os filtros ou troque o modo de ataque."
            />
          ) : (
            <>
              {empresas.map((e) => (
                <RadarLinha key={e.cnpj} empresa={e} hojeISO={hojeISO} onAbrir={() => setAberta(e)} />
              ))}
              <div ref={sentinelRef} className="h-10 flex items-center justify-center text-xs text-muted-foreground">
                {q.isFetchingNextPage ? 'Carregando…' : q.hasNextPage ? '' : 'Fim da lista'}
              </div>
            </>
          )}
        </div>
      )}

      <RadarDetailSheet empresa={aberta} hojeISO={hojeISO} onClose={() => setAberta(null)} />
    </div>
  );
}
