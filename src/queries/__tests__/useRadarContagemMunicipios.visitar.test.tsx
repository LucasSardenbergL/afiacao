import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * "Para visitar" no agregado (migration 20261111160000): o mapa/ranking mandam `p_so_visitar`; o número do chip
 * DESLIGADO lê o agregado com `p_so_agregado` (nunca o caminho vivo), `p_limit` 1 e a cidade da fila, e só quando o
 * recorte cabe nele. Builder FALSO: prova a FORMA da chamada, não o banco (o banco: db/test-radar-agregado-visitar.sh).
 */
let rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
let resposta: unknown[] = [];
const LOTES = [{ mes_referencia: '2026-10', status: 'complete', total_recebido: 500000, novos: 1000, iniciado_em: '2026-10-29T03:00:00+00:00' }];

function builder(tabela: string) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'like', 'is', 'or', 'filter', 'in', 'order', 'range', 'limit', 'abortSignal']) {
    b[m] = () => b;
  }
  b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) =>
    Promise.resolve(tabela === 'radar_ingest_state' ? { data: LOTES, error: null } : { data: [], error: null }).then(res, rej);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => builder(t),
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      const r = Promise.resolve({ data: fn === 'radar_contagem_por_municipio' ? resposta : [], error: null });
      return Object.assign(r, { range: () => r, abortSignal: () => r, order: () => r });
    },
  },
}));

import { useRadarContagemMunicipios } from '../useRadarContagemMunicipios';
import { useRadarParaVisitarContagem } from '../useRadarContatoContabil';
import type { RadarFiltros } from '../useRadarLista';

const FILTROS: RadarFiltros = {
  busca: '', uf: '', municipio: '', cnae: '', status: '', incluirJaClientes: false, comTelefone: false,
  preset: 'novas', incluirSaiuDoDump: false, soIneditos: false, soSugeridos: false,
};
function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const contagens = () => rpcs.filter((r) => r.fn === 'radar_contagem_por_municipio').map((r) => r.args);

beforeEach(() => { rpcs = []; resposta = []; });

describe('mapa/ranking — p_so_visitar', () => {
  it('chip ligado manda p_so_visitar true; desligado, false dito', async () => {
    const a = renderHook(() => useRadarContagemMunicipios({ ...FILTROS, paraVisitar: true }, '2026-11-09', true), { wrapper });
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));
    expect(contagens()[0]).toMatchObject({ p_so_visitar: true, p_limit: 500 });
    rpcs = [];
    const b = renderHook(() => useRadarContagemMunicipios(FILTROS, '2026-11-09', true), { wrapper });
    await waitFor(() => expect(b.result.current.isSuccess).toBe(true));
    expect(contagens()[0]).toMatchObject({ p_so_visitar: false });
  });
});

describe('número do chip desligado — do agregado', () => {
  it('recorte que cabe: p_so_agregado, p_limit 1, a cidade da fila e o total da resposta', async () => {
    resposta = [{ municipio_codigo: '8105', total: 900, para_visitar: 41, para_visitar_total: 41, visitar_contado_em: '2026-11-09T10:35:00Z' }];
    const { result } = renderHook(
      () => useRadarParaVisitarContagem({ ...FILTROS, uf: 'SC', municipio: 'JOINVILLE', municipioCodigo: '8105' }, '2026-11-09'),
      { wrapper },
    );
    await waitFor(() => expect(result.current.rotulo).toBe('41'));
    expect(result.current.contadoEm).toBe('2026-11-09T10:35:00Z');
    expect(contagens()).toHaveLength(1);
    expect(contagens()[0]).toMatchObject({ p_so_agregado: true, p_limit: 1, p_municipio_codigo: '8105', p_uf: 'SC', p_lote: '2026-10' });
    expect(contagens()[0].p_so_visitar, 'o total do chip desligado é do recorte SEM o chip').toBeUndefined();
  });

  it('resposta vazia (recorte fora dos agregados): sem número, nunca 0', async () => {
    resposta = [];
    const { result } = renderHook(() => useRadarParaVisitarContagem(FILTROS, '2026-11-09'), { wrapper });
    await waitFor(() => expect(contagens()).toHaveLength(1));
    await waitFor(() => expect(result.current.isError).toBe(false));
    expect(result.current.rotulo).toBe('');
    expect(result.current.data).toBeNull();
  });

  it('busca textual (o agregado não a conhece): nenhuma leitura, sem número', async () => {
    const { result } = renderHook(() => useRadarParaVisitarContagem({ ...FILTROS, busca: 'tintas' }, '2026-11-09'), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(contagens()).toHaveLength(0);
    expect(result.current.rotulo).toBe('');
  });

  it('visão "Meus atendimentos" (desligado): nenhuma leitura', async () => {
    renderHook(() => useRadarParaVisitarContagem(FILTROS, '2026-11-09', { desligado: true }), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(contagens()).toHaveLength(0);
  });
});
