import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * A fila do Radar é a FOTO VIGENTE: por default só `ultimo_lote = lote vigente`.
 *
 * Medido em prod (psql-ro, 2026-10-19): 52.011 leads ativos com ultimo_lote=2026-05 (saíram do
 * dump da RFB) seguiam na fila de 2026-08 porque `useRadarLista` só filtrava ja_cliente/status.
 * O supabase é um builder FALSO que grava a cadeia de filtros por tabela — o que se prova aqui
 * é a FORMA da query (quais filtros entram), não o banco.
 */
type Chamada = [string, ...unknown[]];
const chamadas: Record<string, Chamada[]> = {};
let respostas: Record<string, { data: unknown; error: { message: string } | null }> = {};

function builder(tabela: string) {
  chamadas[tabela] = chamadas[tabela] ?? [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'or', 'eq', 'neq', 'gte', 'lte', 'like', 'order', 'range', 'limit']) {
    b[m] = (...args: unknown[]) => { chamadas[tabela].push([m, ...args]); return b; };
  }
  b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(respostas[tabela]).then(res, rej);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => builder(t) } }));

import { useRadarLista, type RadarFiltros } from '../useRadarLista';

const FILTROS: RadarFiltros = {
  busca: '', uf: '', municipio: '', cnae: '', status: '', incluirJaClientes: false, comTelefone: false,
  preset: 'novas', incluirSaiuDoDump: false, soIneditos: false,
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
const filtroLote = () => chamadas.radar_empresas.filter((c) => c[0] === 'eq' && c[1] === 'ultimo_lote');
const filtroInedito = () => chamadas.radar_empresas.filter((c) => c[0] === 'gte' && c[1] === 'primeira_vista_em');

beforeEach(() => {
  for (const k of Object.keys(chamadas)) delete chamadas[k];
  respostas = {
    radar_ingest_state: { data: LOTES, error: null },
    radar_empresas: { data: [], error: null },
  };
});

describe('useRadarLista — a fila é a foto vigente', () => {
  it('default: filtra ultimo_lote = lote VIGENTE (o maior complete; o running no meio é ignorado)', async () => {
    const { result } = renderHook(() => useRadarLista(FILTROS, '2026-10-19'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(filtroLote()).toEqual([['eq', 'ultimo_lote', '2026-08']]);
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
    expect(filtroLote()).toEqual([['eq', 'ultimo_lote', '2026-08']]);
    expect(filtroInedito()).toEqual([['gte', 'primeira_vista_em', '2026-10-19T16:31:08.593+00:00']]);
  });

  it('sem lote complete: não filtra por lote (ausente ≠ "nenhum"; espelha o `v_lote IS NULL OR` da RPC)', async () => {
    respostas.radar_ingest_state = { data: [LOTES[0]], error: null };
    const { result } = renderHook(() => useRadarLista(FILTROS, '2026-10-19'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(filtroLote()).toEqual([]);
    expect(chamadas.radar_empresas.length).toBeGreaterThan(0);
  });

  it('leitura do lote FALHOU: a lista erra junto — nunca mostra a fila sem saber o lote', async () => {
    respostas.radar_ingest_state = { data: null, error: { message: 'boom' } };
    const { result } = renderHook(() => useRadarLista(FILTROS, '2026-10-19'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(chamadas.radar_empresas ?? []).toEqual([]);
  });
});
