import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Ranking de cidades e mapa contam o MESMO universo da fila (foto vigente da RFB).
 *
 * Medido em prod (psql-ro, 2026-10-20): sem p_lote a RPC `radar_contagem_por_municipio` contava os
 * 52.011 leads com ultimo_lote=2026-05 que saíram do dump de 2026-08 — São Paulo 26.794 no ranking
 * × 24.910 na fila. O que se prova aqui é o ARGUMENTO que a RPC recebe (o banco é provado em
 * db/test-radar-contagem-lote.sh): p_lote = lote vigente por default, null com "incluir quem saiu".
 */
let rpcs: Array<[string, Record<string, unknown>]> = [];
let respostaLotes: { data: unknown; error: { message: string } | null };

function builderLotes() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit']) b[m] = () => b;
  b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(respostaLotes).then(res, rej);
  return b;
}
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => builderLotes(),
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcs.push([fn, args]);
      return Promise.resolve({ data: [], error: null });
    },
  },
}));

import { useRadarContagemMunicipios } from '../useRadarContagemMunicipios';
import type { RadarFiltros } from '../useRadarLista';

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
const argsDaContagem = () => {
  const chamadas = rpcs.filter(([fn]) => fn === 'radar_contagem_por_municipio');
  expect(chamadas).toHaveLength(1);
  return chamadas[0][1];
};

beforeEach(() => {
  rpcs = [];
  respostaLotes = { data: LOTES, error: null };
});

describe('useRadarContagemMunicipios — ranking/mapa contam o universo da fila', () => {
  it('default: p_lote = lote VIGENTE (o maior complete; o running é ignorado), sem recorte de inéditos', async () => {
    const { result } = renderHook(() => useRadarContagemMunicipios(FILTROS, '2026-10-19', true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const args = argsDaContagem();
    expect(args.p_lote).toBe('2026-08');
    expect(args.p_primeira_vista_min).toBeNull();
    expect(args.p_limit).toBe(500);
  });

  it('incluirSaiuDoDump: p_lote null (conta também quem saiu do dump)', async () => {
    const { result } = renderHook(
      () => useRadarContagemMunicipios({ ...FILTROS, incluirSaiuDoDump: true }, '2026-10-19', true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const args = argsDaContagem();
    expect(args.p_lote).toBeNull();
    expect(args.p_primeira_vista_min).toBeNull();
  });

  it('soIneditos: lote vigente + primeira vista >= início do lote — vence o incluirSaiuDoDump, como na fila', async () => {
    const { result } = renderHook(
      () => useRadarContagemMunicipios({ ...FILTROS, incluirSaiuDoDump: true, soIneditos: true }, '2026-10-19', true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const args = argsDaContagem();
    expect(args.p_lote).toBe('2026-08');
    expect(args.p_primeira_vista_min).toBe('2026-10-19T16:31:08.593+00:00');
  });

  it('sem lote complete: p_lote null (sem foto para recortar — ausente ≠ "nenhum")', async () => {
    respostaLotes = { data: [LOTES[0]], error: null };
    const { result } = renderHook(() => useRadarContagemMunicipios(FILTROS, '2026-10-19', true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(argsDaContagem().p_lote).toBeNull();
  });

  it('leitura do lote FALHOU: o ranking erra junto e a RPC nem é chamada', async () => {
    respostaLotes = { data: null, error: { message: 'boom' } };
    const { result } = renderHook(() => useRadarContagemMunicipios(FILTROS, '2026-10-19', true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(rpcs).toEqual([]);
  });
});
