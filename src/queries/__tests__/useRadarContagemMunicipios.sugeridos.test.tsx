import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Ranking/mapa sob "só sugeridos" contam o MESMO conjunto da fila e do card: o predicado é o
 * `filtrarSugeridos` (não uma cópia em SQL), agregado por município no cliente. A RPC nem é
 * chamada. O builder é FALSO e grava a cadeia de filtros por tabela — o que se prova é a FORMA
 * da consulta, a paginação e a agregação.
 */
type Chamada = [string, ...unknown[]];
const chamadas: Record<string, Chamada[]> = {};
let rpcs: string[] = [];
let respostas: Record<string, Array<{ data: unknown; error: { message: string } | null }>> = {};

function builder(tabela: string) {
  chamadas[tabela] = chamadas[tabela] ?? [];
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'like', 'is', 'or', 'filter', 'in', 'order', 'range', 'limit']) {
    b[m] = (...args: unknown[]) => { chamadas[tabela].push([m, ...args]); return b; };
  }
  b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => {
    const fila = respostas[tabela] ?? [];
    const r = fila.length > 1 ? fila.shift() : fila[0];
    return Promise.resolve(r).then(res, rej);
  };
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => builder(t),
    rpc: (fn: string) => { rpcs.push(fn); return Promise.resolve({ data: [], error: null }); },
  },
}));

import { useRadarContagemMunicipios } from '../useRadarContagemMunicipios';
import type { RadarFiltros } from '../useRadarLista';

const FILTROS: RadarFiltros = {
  busca: '', uf: '', municipio: '', cnae: '', status: '', incluirJaClientes: false, comTelefone: false,
  preset: 'novas', incluirSaiuDoDump: false, soIneditos: false, soSugeridos: true,
};
const LOTE = { mes_referencia: '2026-08', status: 'complete', total_recebido: 501380, novos: 27466, iniciado_em: '2026-10-19T16:31:08.593+00:00' };
const linha = (mc: string, uf: string, tel: string | null) =>
  ({ municipio_codigo: mc, municipio_nome: `CIDADE ${mc}`, uf, telefone1: tel, telefone2: null, prospeccao_status: 'em_conversa' });

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const filtrosEmpresas = (m: string, col?: string) =>
  (chamadas.radar_empresas ?? []).filter((c) => c[0] === m && (col === undefined || c[1] === col));

beforeEach(() => {
  for (const k of Object.keys(chamadas)) delete chamadas[k];
  rpcs = [];
  respostas = {
    radar_ingest_state: [{ data: [LOTE], error: null }],
    radar_empresas: [{ data: [linha('M2', 'MG', null), linha('M1', 'SC', '47'), linha('M1', 'SC', null)], error: null }],
    radar_municipios: [{ data: [{ codigo: 'M1', nome: 'JOINVILLE', lat: -26.3, lng: -48.8 }, { codigo: 'M2', nome: 'BETIM', lat: -19.9, lng: -44.2 }], error: null }],
  };
});

describe('useRadarContagemMunicipios — "só sugeridos" usa o predicado da fila', () => {
  it('aplica filtrarSugeridos inteiro (lote vigente, em_conversa, sem Omie, RFB, CNPJ, score) e NÃO chama a RPC', async () => {
    const { result } = renderHook(() => useRadarContagemMunicipios(FILTROS, '2026-10-21', true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpcs).toEqual([]);
    expect(filtrosEmpresas('eq', 'ultimo_lote')).toEqual([['eq', 'ultimo_lote', '2026-08']]);
    expect(filtrosEmpresas('eq', 'prospeccao_status')).toEqual([['eq', 'prospeccao_status', 'em_conversa']]);
    expect(filtrosEmpresas('eq', 'ja_cliente')).toEqual([['eq', 'ja_cliente', false]]);
    expect(filtrosEmpresas('is', 'omie_codigo_cliente')).toEqual([['is', 'omie_codigo_cliente', null]]);
    expect(filtrosEmpresas('or')).toEqual([['or', 'rfb_situacao.is.null,rfb_situacao.eq.02']]);
    expect(filtrosEmpresas('filter', 'cnpj')).toHaveLength(1);
    expect(filtrosEmpresas('gte', 'score')).toHaveLength(1);
    expect(filtrosEmpresas('order')).toEqual([['order', 'cnpj']]);
  });

  it('agrega por município na forma e ordem da RPC (total desc), com nome/coords de radar_municipios', async () => {
    const { result } = renderHook(() => useRadarContagemMunicipios(FILTROS, '2026-10-21', true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { municipio_codigo: 'M1', municipio_nome: 'JOINVILLE', uf: 'SC', lat: -26.3, lng: -48.8, total: 2, com_telefone: 1, a_contatar: 0 },
      { municipio_codigo: 'M2', municipio_nome: 'BETIM', uf: 'MG', lat: -19.9, lng: -44.2, total: 1, com_telefone: 0, a_contatar: 0 },
    ]);
  });

  it('soma os filtros estruturais da RPC (UF, CNAE) e o recorte de inéditos', async () => {
    const { result } = renderHook(
      () => useRadarContagemMunicipios({ ...FILTROS, uf: 'SC', cnae: '2542', soIneditos: true }, '2026-10-21', true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(filtrosEmpresas('eq', 'uf')).toEqual([['eq', 'uf', 'SC']]);
    expect(filtrosEmpresas('like', 'cnae_principal')).toEqual([['like', 'cnae_principal', '2542%']]);
    expect(filtrosEmpresas('gte', 'primeira_vista_em')).toEqual([['gte', 'primeira_vista_em', '2026-10-19T16:31:08.593+00:00']]);
  });

  it('pagina por range até a página incompleta — não para no teto de 1.000 do PostgREST', async () => {
    const cheia = Array.from({ length: 1000 }, () => linha('M1', 'SC', null));
    respostas.radar_empresas = [{ data: cheia, error: null }, { data: [linha('M2', 'MG', null)], error: null }];
    const { result } = renderHook(() => useRadarContagemMunicipios(FILTROS, '2026-10-21', true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(filtrosEmpresas('range')).toEqual([['range', 0, 999], ['range', 1000, 1999]]);
    expect(result.current.data?.map((c) => [c.municipio_codigo, c.total])).toEqual([['M1', 1000], ['M2', 1]]);
  });

  it('sem lote completo: FALHA como a fila (nunca conta a foto geral sob o rótulo "sugeridos")', async () => {
    respostas.radar_ingest_state = [{ data: [{ ...LOTE, status: 'running' }], error: null }];
    const { result } = renderHook(() => useRadarContagemMunicipios(FILTROS, '2026-10-21', true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(rpcs).toEqual([]);
    expect(chamadas.radar_empresas ?? []).toEqual([]);
  });

  it('erro numa página LANÇA — contagem parcial seria um número menor fabricado', async () => {
    respostas.radar_empresas = [{ data: null, error: { message: 'boom' } }];
    const { result } = renderHook(() => useRadarContagemMunicipios(FILTROS, '2026-10-21', true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
