import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Radar, RotateCcw } from 'lucide-react';
import { useUrlState } from '@/hooks/useUrlState';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { useRadarLista, type RadarFiltros, type RadarEmpresa } from '@/queries/useRadarLista';
import { useRadarKpis } from '@/queries/useRadarKpis';
import { useRadarLoteOmie } from '@/queries/useRadarLote';
import { useRadarLoteVigente } from '@/queries/useRadarLoteVigente';
import { RadarKpis } from '@/components/radar/RadarKpis';
import { RadarFiltros as Filtros } from '@/components/radar/RadarFiltros';
import { RadarLinha } from '@/components/radar/RadarLinha';
import { RadarDetailSheet } from '@/components/radar/RadarDetailSheet';
import { RadarRankingCidades } from '@/components/radar/RadarRankingCidades';
import { RadarAcoesLote } from '@/components/radar/RadarAcoesLote';
import { RadarLoteDialog } from '@/components/radar/RadarLoteDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { PresetRadar } from '@/lib/radar/ui-helpers';
import { TETO_LOTE } from '@/lib/radar/lote';
import { track } from '@/lib/analytics';

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
  incluirSaiuDoDump: boolean;
  soIneditos: boolean;
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
  incluirSaiuDoDump: false,
  soIneditos: false,
  preset: 'score',
  vista: 'lista',
};

function narrowPreset(v: string): PresetRadar {
  return v === 'estabelecidas' || v === 'novas' ? v : 'score';
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
  const loteOmie = useRadarLoteOmie();
  // Lote VIGENTE (foto da RFB) — UMA leitura, compartilhada com a fila (que a lê pelo cache),
  // o card de inéditos, a linha e a ficha. `null` = nenhum lote completo (sem selos, fila sem filtro).
  const lote = useRadarLoteVigente().data ?? null;
  const [loteAberto, setLoteAberto] = useState(false);

  // Seleção por CNPJ, com SNAPSHOT de cada empresa: a linha pode sair da lista (virou
  // cliente, refetch) e a ação em lote ainda precisa dos dados dela.
  const [selecao, setSelecao] = useState<Map<string, RadarEmpresa>>(new Map());
  const chaveFiltros = JSON.stringify(filtros);
  const chaveAnterior = useRef(chaveFiltros);
  useEffect(() => {
    if (chaveAnterior.current !== chaveFiltros) {
      chaveAnterior.current = chaveFiltros;
      setSelecao(new Map()); // trocar filtro = outra fila; seleção velha confundiria
    }
  }, [chaveFiltros]);

  // Ficha aberta por CNPJ; o objeto é relido da lista a cada render (não fica velho).
  const [abertaCnpj, setAbertaCnpj] = useState<string | null>(null);
  const abertaSnapshot = useRef<RadarEmpresa | null>(null);

  // Paginação CONGELADA enquanto um lote roda: a lista é por offset e as cadastradas
  // somem da fila — carregar a página seguinte no meio pularia empresas.
  const podePaginar = !!q.hasNextPage && !q.isFetchingNextPage && !loteOmie.rodando;
  const sentinelRef = useInfiniteScroll(() => q.fetchNextPage(), podePaginar);

  const empresas = useMemo(() => q.data?.pages.flat() ?? [], [q.data]);
  const aberta = useMemo(() => {
    if (!abertaCnpj) return null;
    const atual = empresas.find((e) => e.cnpj === abertaCnpj) ?? abertaSnapshot.current;
    abertaSnapshot.current = atual;
    return atual;
  }, [abertaCnpj, empresas]);

  const abrir = useCallback((e: RadarEmpresa) => { abertaSnapshot.current = e; setAbertaCnpj(e.cnpj); }, []);
  const proximo = useCallback(() => {
    if (!abertaCnpj) return;
    const i = empresas.findIndex((e) => e.cnpj === abertaCnpj);
    const prox = empresas[i + 1] ?? empresas.find((e) => e.cnpj !== abertaCnpj);
    if (prox) { track('radar.proximo_lead', {}); abrir(prox); } else setAbertaCnpj(null);
  }, [abertaCnpj, empresas, abrir]);

  const selecionar = useCallback((e: RadarEmpresa, v: boolean) => {
    setSelecao((s) => {
      const n = new Map(s);
      if (v) n.set(e.cnpj, e); else n.delete(e.cnpj);
      return n;
    });
  }, []);
  const removerDaSelecao = useCallback((cnpjs: string[]) => {
    setSelecao((s) => { const n = new Map(s); for (const c of cnpjs) n.delete(c); return n; });
  }, []);
  const todosCarregadosMarcados = empresas.length > 0 && empresas.every((e) => selecao.has(e.cnpj));
  const alternarCarregados = (v: boolean) => {
    track('radar.selecionar_carregados', { total: empresas.length, marcar: v });
    setSelecao((s) => {
      const n = new Map(s);
      for (const e of empresas) { if (v) n.set(e.cnpj, e); else n.delete(e.cnpj); }
      return n;
    });
  };

  const pendentesDoLote = loteOmie.progresso?.pendentes ?? 0;

  return (
    <div className="p-4 space-y-4 max-w-6xl mx-auto pb-24">
      <div className="flex items-center gap-2">
        <Radar className="w-5 h-5" />
        <h1 className="text-2xl font-display">Radar de Clientes</h1>
        {kpis.data?.lote && (
          <span className="ml-2 text-xs text-muted-foreground border rounded px-2 py-0.5">
            lote {kpis.data.lote}
          </span>
        )}
        <div className="ml-auto flex gap-1">
          <Button variant={raw.vista !== 'mapa' ? 'default' : 'outline'} size="sm" onClick={() => set({ vista: 'lista' })}>
            Lista
          </Button>
          <Button
            variant={raw.vista === 'mapa' ? 'default' : 'outline'}
            size="sm"
            onClick={() => { track('radar.mapa_aberto', {}); set({ vista: 'mapa' }); }}
          >
            Mapa
          </Button>
        </div>
      </div>
      <RadarKpis soIneditos={filtros.soIneditos} onSoIneditos={(v) => set({ soIneditos: v })} />
      <Filtros filtros={filtros} set={set} lote={lote} />
      <RadarRankingCidades filtros={filtros} hojeISO={hojeISO} onPick={(nome) => { track('radar.cidade_selecionada', {}); set({ municipio: nome }); }} />

      {/* Lote interrompido (aba fechada, parada, falhas): oferece retomar em vez de fingir que nada aconteceu. */}
      {loteOmie.lote && !loteOmie.rodando && pendentesDoLote > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm">
          <RotateCcw className="w-4 h-4 text-status-warning shrink-0" />
          <span className="flex-1">
            Lote de cadastro no Omie com <strong>{pendentesDoLote}</strong> lead{pendentesDoLote === 1 ? '' : 's'} pendente{pendentesDoLote === 1 ? '' : 's'}
            {' '}(iniciado {new Date(loteOmie.lote.iniciadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}).
          </span>
          <Button size="sm" variant="outline" onClick={() => setLoteAberto(true)}>Ver / retomar</Button>
        </div>
      )}
      {loteOmie.rodando && !loteAberto && (
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <span className="flex-1">Cadastrando no Omie… {loteOmie.progresso?.feitos ?? 0}/{loteOmie.progresso?.total ?? 0}</span>
          <Button size="sm" variant="outline" onClick={() => setLoteAberto(true)}>Acompanhar</Button>
        </div>
      )}

      {raw.vista === 'mapa' ? (
        <Suspense fallback={<Skeleton className="h-[420px]" />}>
          <RadarMapa
            filtros={filtros}
            hojeISO={hojeISO}
            onPick={(nome) => { track('radar.cidade_selecionada', {}); set({ municipio: nome, vista: 'lista' }); }}
          />
        </Suspense>
      ) : (
        <div className="rounded-md border">
          {empresas.length > 0 && (
            <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={todosCarregadosMarcados}
                onCheckedChange={(v) => alternarCarregados(v === true)}
                aria-label="Selecionar todos os carregados"
              />
              <span>
                {todosCarregadosMarcados ? 'Desmarcar' : 'Selecionar'} os {empresas.length} carregados
                {q.hasNextPage ? ' (há mais páginas — role para carregar)' : ''}
                {empresas.length > TETO_LOTE ? ` · ações em lote tratam até ${TETO_LOTE} por vez` : ''}
              </span>
              {selecao.size > 0 && <span className="ml-auto tabular-nums">{selecao.size} selecionado{selecao.size === 1 ? '' : 's'}</span>}
            </div>
          )}
          {q.isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10" />)}
            </div>
          ) : q.isError ? (
            <EmptyState tone="operational" icon={Radar} title="Não foi possível carregar" description="Tente novamente em instantes." />
          ) : empresas.length === 0 ? (
            <EmptyState tone="operational" icon={Radar} title="Nenhuma empresa nesta fila" description="Ajuste os filtros ou troque o modo de ataque." />
          ) : (
            <>
              {empresas.map((e) => (
                <RadarLinha
                  key={e.cnpj}
                  empresa={e}
                  hojeISO={hojeISO}
                  selecionada={selecao.has(e.cnpj)}
                  onSelecionar={(v) => selecionar(e, v)}
                  onAbrir={() => abrir(e)}
                  lote={lote}
                />
              ))}
              <div ref={sentinelRef} className="h-10 flex items-center justify-center text-xs text-muted-foreground">
                {q.isFetchingNextPage ? 'Carregando…' : loteOmie.rodando && q.hasNextPage ? 'Paginação pausada enquanto o lote roda' : q.hasNextPage ? '' : 'Fim da lista'}
              </div>
            </>
          )}
        </div>
      )}

      <RadarAcoesLote
        selecao={Array.from(selecao.values())}
        onLimpar={() => setSelecao(new Map())}
        onRemover={removerDaSelecao}
        loteOmie={loteOmie}
        onAbrirLote={() => setLoteAberto(true)}
      />
      <RadarLoteDialog lote={loteOmie} open={loteAberto} onClose={() => setLoteAberto(false)} />
      <RadarDetailSheet empresa={aberta} hojeISO={hojeISO} onClose={() => setAbertaCnpj(null)} onProximo={proximo} lote={lote} />
    </div>
  );
}
