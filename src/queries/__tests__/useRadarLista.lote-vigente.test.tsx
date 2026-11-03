import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * A fila do Radar é a FOTO VIGENTE: por default só `ultimo_lote = lote vigente`.
 *
 * Medido em prod (psql-ro, 2026-10-19): 52.011 leads ativos com ultimo_lote=2026-05 (saíram do
 * dump da RFB) seguiam na fila de 2026-08 porque `useRadarLista` só filtrava ja_cliente/status.
 * O supabase é FALSO: o builder grava a cadeia por tabela e o `.rpc()` grava os argumentos da
 * `radar_lista` (a lista lê pela RPC desde 20261103131500). Prova-se a FORMA da chamada (quais recortes
 * vão ao banco); que a RPC aplica cada um como a consulta de antes é a prova PG17
 * `db/test-radar-lista-rpc.sh`.
 */
type Chamada = [string, ...unknown[]];
type Args = Record<string, unknown>;
const chamadas: Record<string, Chamada[]> = {};
let lista: Args[] = [];
let respostas: Record<string, { data: unknown; error: { message: string } | null }> = {};

function builder(tabela: string) {
  chamadas[tabela] = chamadas[tabela] ?? [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'or', 'eq', 'neq', 'gte', 'lte', 'like', 'is', 'filter', 'order', 'range', 'limit']) {
    b[m] = (...args: unknown[]) => { chamadas[tabela].push([m, ...args]); return b; };
  }
  b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(respostas[tabela]).then(res, rej);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => builder(t),
    rpc: (fn: string, args: Args) => {
      if (fn !== 'radar_lista') throw new Error(`rpc inesperada: ${fn}`);
      lista.push(args);
      return Promise.resolve(respostas.radar_lista);
    },
  },
}));

import { useRadarLista, type RadarFiltros } from '../useRadarLista';

const FILTROS: RadarFiltros = {
  busca: '', uf: '', municipio: '', cnae: '', status: '', incluirJaClientes: false, comTelefone: false,
  preset: 'novas', incluirSaiuDoDump: false, soIneditos: false, soSugeridos: false,
};
const LOTES = [
  { mes_referencia: '2026-10', status: 'running', total_recebido: 0, novos: null, iniciado_em: '2026-11-02T03:00:00+00:00' },
  { mes_referencia: '2026-08', status: 'complete', total_recebido: 501380, novos: 27466, iniciado_em: '2026-10-19T16:31:08.593+00:00' },
  { mes_referencia: '2026-05', status: 'complete', total_recebido: 526176, novos: 526176, iniciado_em: '2026-06-12T01:05:18.706+00:00' },
];

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const filtroLote = () => lista.map((a) => a.p_ultimo_lote).filter((v) => v !== undefined);
const filtroInedito = () => lista.map((a) => a.p_primeira_vista_min).filter((v) => v !== undefined);

beforeEach(() => {
  for (const k of Object.keys(chamadas)) delete chamadas[k];
  lista = [];
  respostas = {
    radar_ingest_state: { data: LOTES, error: null },
    radar_lista: { data: [], error: null },
  };
});

describe('useRadarLista — a fila é a foto vigente', () => {
  it('default: filtra ultimo_lote = lote VIGENTE (o maior complete; o running no meio é ignorado)', async () => {
    const { result } = renderHook(() => useRadarLista(FILTROS, '2026-10-19'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(filtroLote()).toEqual(['2026-08']);
    expect(filtroInedito()).toEqual([]);
  });

  it('incluirSaiuDoDump: a fila volta a trazer quem saiu do dump (sem filtro de lote)', async () => {
    const { result } = renderHook(() => useRadarLista({ ...FILTROS, incluirSaiuDoDump: true }, '2026-10-19'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(filtroLote()).toEqual([]);
  });

  it('soIneditos: lote vigente E primeira_vista_em >= iniciado_em do lote — mesmo com incluirSaiuDoDump', async () => {
    const { result } = renderHook(
      () => useRadarLista({ ...FILTROS, incluirSaiuDoDump: true, soIneditos: true }, '2026-10-19'),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(filtroLote()).toEqual(['2026-08']);
    expect(filtroInedito()).toEqual(['2026-10-19T16:31:08.593+00:00']);
  });

  it('sem lote complete: não filtra por lote (ausente ≠ "nenhum"; espelha o `v_lote IS NULL OR` da RPC)', async () => {
    respostas.radar_ingest_state = { data: [LOTES[0]], error: null };
    const { result } = renderHook(() => useRadarLista(FILTROS, '2026-10-19'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(filtroLote()).toEqual([]);
    expect(lista.length).toBeGreaterThan(0);
  });

  it('leitura do lote FALHOU: a lista erra junto — nunca mostra a fila sem saber o lote', async () => {
    respostas.radar_ingest_state = { data: null, error: { message: 'boom' } };
    const { result } = renderHook(() => useRadarLista(FILTROS, '2026-10-19'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(lista).toEqual([]);
  });
});

describe('useRadarLista — filtro "só sugeridos para cadastro" (bloco 5)', () => {
  it('pede à RPC o predicado do card (lote vigente + limiar do score); o predicado em si é provado no PG17 (E14)', async () => {
    const { result } = renderHook(() => useRadarLista({ ...FILTROS, soSugeridos: true, status: 'a_contatar' }, '2026-10-20'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(lista[0]).toMatchObject({ p_sugeridos_lote: '2026-08', p_sugeridos_score_min: 70 });
    // o predicado fixa status e lote: os filtros comuns não vão junto
    expect(lista[0].p_status).toBeUndefined();
    expect(lista[0].p_ultimo_lote).toBeUndefined();
  });

  it('vence "incluir já-clientes" e "incluir quem saiu do dump": sugerido é por definição não-cliente e da foto', async () => {
    const { result } = renderHook(() => useRadarLista({ ...FILTROS, soSugeridos: true, incluirJaClientes: true, incluirSaiuDoDump: true }, '2026-10-20'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(lista[0]).toMatchObject({ p_sugeridos_lote: '2026-08', p_incluir_ja_clientes: false });
    expect(lista[0].p_ultimo_lote).toBeUndefined();
  });

  it('sem lote vigente: a lista FALHA com o motivo — nunca a fila geral sob o rótulo "só sugeridos"', async () => {
    respostas.radar_ingest_state = { data: [LOTES[0]], error: null };
    const { result } = renderHook(() => useRadarLista({ ...FILTROS, soSugeridos: true }, '2026-10-20'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(String(result.current.error)).toMatch(/Sem lote completo/);
    expect(lista, 'consultou a fila geral').toEqual([]);
  });

  it('controle: SEM o filtro e sem lote, a fila roda inteira (a falha acima é do filtro, não do lote)', async () => {
    respostas.radar_ingest_state = { data: [LOTES[0]], error: null };
    const { result } = renderHook(() => useRadarLista({ ...FILTROS, soSugeridos: false }, '2026-10-20'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

/**
 * Paginação presa ao lote (Codex, código 2026-10-20, achado 5): a fila lia o lote DENTRO de cada
 * página e a chave não tinha o lote — se o vigente virava no meio da rolagem, a página 2 vinha do
 * lote novo e se juntava às de agosto (as antigas perdiam o selo). A identidade do lote entra na
 * chave (troca de lote = fila recomeça do topo) e uma página seguinte que leia OUTRO lote recusa.
 */
describe('useRadarLista — paginação presa ao lote vigente', () => {
  const LOTE_NOVO = { mes_referencia: '2026-09', status: 'complete', total_recebido: 503000, novos: 1200, iniciado_em: '2026-10-21T03:00:00+00:00' };
  const LOTE_KEY = ['radar', 'lote-vigente'];
  function comCliente() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const w = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    return { qc, w };
  }
  /** Uma chamada da RPC = uma consulta à fila. */
  const consultas = () => lista;
  const loteDa = (a: Args) => a.p_ultimo_lote;
  const inicioDa = (a: Args) => a.p_offset;

  it('o lote vigente TROCA: a fila recomeça do topo com o lote novo', async () => {
    const { qc, w } = comCliente();
    const { result } = renderHook(() => useRadarLista(FILTROS, '2026-10-21'), { wrapper: w });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(consultas().map(loteDa)).toEqual(['2026-08']);

    respostas.radar_ingest_state = { data: [LOTE_NOVO, ...LOTES], error: null };
    await qc.invalidateQueries({ queryKey: LOTE_KEY });

    await waitFor(() => expect(consultas().map(loteDa)).toEqual(['2026-08', '2026-09']), { timeout: 2000 });
    expect(inicioDa(consultas()[1]), 'não recomeçou do topo').toBe(0);
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1));
  });

  it('corrida: a página seguinte lê um lote NOVO antes da chave mudar — nunca é montada com ele', async () => {
    const { qc, w } = comCliente();
    respostas.radar_lista = { data: Array.from({ length: 50 }, (_, i) => ({ cnpj: String(i).padStart(14, '0') })), error: null };
    const { result } = renderHook(() => useRadarLista(FILTROS, '2026-10-21'), { wrapper: w });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));

    // lote fica velho no cache SEM refetch (ninguém observou a troca ainda) e a carga de setembro fecha
    respostas.radar_ingest_state = { data: [LOTE_NOVO, ...LOTES], error: null };
    await qc.invalidateQueries({ queryKey: LOTE_KEY, refetchType: 'none' });
    await result.current.fetchNextPage();

    await waitFor(() => expect(consultas().some((c) => loteDa(c) === '2026-09')).toBe(true), { timeout: 2000 });
    const misturadas = consultas().filter((c) => (inicioDa(c) as number) > 0 && loteDa(c) === '2026-09');
    expect(misturadas, 'página 2 montada com o lote novo, colada nas páginas do lote velho').toEqual([]);
  });
});
