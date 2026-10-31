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
let ranges: Array<[string, number, number]> = [];
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
      // Encadeável como o builder real (`.order().range()`), e then-able para quem só aguarda.
      const b: Record<string, unknown> = {};
      b.order = () => b;
      b.range = (de: number, ate: number) => {
        ranges.push([fn, de, ate]);
        return b;
      };
      b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) =>
        Promise.resolve({ data: [], error: null }).then(res, rej);
      return b;
    },
  },
}));

import {
  useRadarContagemMunicipios,
  useRadarPenetracaoMunicipios,
  penetracaoMedia,
  faixaPenetracao,
  oportunidadesPenetracao,
  formatarPenetracao,
  type RadarMunicipioPenetracao,
} from '../useRadarContagemMunicipios';
import type { RadarFiltros } from '../useRadarLista';

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
const argsDaContagem = () => {
  const chamadas = rpcs.filter(([fn]) => fn === 'radar_contagem_por_municipio');
  expect(chamadas).toHaveLength(1);
  return chamadas[0][1];
};

beforeEach(() => {
  rpcs = [];
  ranges = [];
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

// Penetração (frente 4 do mapa). O banco — denominador do lote vigente, NULL sem denominador, concorrentes
// NULL sem publicação — é provado em db/test-radar-penetracao-concorrentes.sh; aqui, o argumento e a leitura.
describe('useRadarPenetracaoMunicipios — denominador do lote vigente', () => {
  it('chama a RPC com o lote VIGENTE e a UF dos filtros', async () => {
    const { result } = renderHook(() => useRadarPenetracaoMunicipios('SC', true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const chamadas = rpcs.filter(([fn]) => fn === 'radar_penetracao_por_municipio');
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0][1]).toEqual({ p_lote: '2026-08', p_uf: 'SC', p_limit: 500 });
    // Pagina (capa de 1.000 do PostgREST vale para .rpc()); página curta encerra na 1ª chamada.
    expect(ranges).toEqual([['radar_penetracao_por_municipio', 0, 999]]);
  });

  it('sem UF: p_uf null dito (o país inteiro)', async () => {
    const { result } = renderHook(() => useRadarPenetracaoMunicipios(null, true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpcs.find(([fn]) => fn === 'radar_penetracao_por_municipio')?.[1].p_uf).toBeNull();
  });

  it('sem lote complete: camada indisponível (null) e a RPC nem é chamada — nunca penetração sobre a foto velha', async () => {
    respostaLotes = { data: [LOTES[0]], error: null };
    const { result } = renderHook(() => useRadarPenetracaoMunicipios(null, true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(rpcs).toEqual([]);
  });

  it('leitura do lote FALHOU: erra junto, sem chamar a RPC', async () => {
    respostaLotes = { data: null, error: { message: 'boom' } };
    const { result } = renderHook(() => useRadarPenetracaoMunicipios(null, true), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(rpcs).toEqual([]);
  });
});

const mun = (codigo: string, empresas: number | null, clientes: number | null, concorrentes: number | null = null): RadarMunicipioPenetracao => ({
  municipio_codigo: codigo, municipio_nome: `CIDADE ${codigo}`, uf: 'SC', lat: -27, lng: -48,
  empresas_lote: empresas, clientes,
  penetracao: empresas != null && empresas > 0 && clientes != null ? clientes / empresas : null,
  concorrentes,
});

describe('penetração — helpers (ausente ≠ zero)', () => {
  const dados = [mun('A', 1000, 5), mun('B', 400, 8), mun('C', 300, 0), mun('D', null, null, 7), mun('E', 50, 1)];

  it('média PONDERADA só sobre quem tem denominador; sem denominador nenhum, null (não 0%)', () => {
    expect(penetracaoMedia(dados)).toBeCloseTo(14 / 1750, 10);
    expect(penetracaoMedia([mun('D', null, null, 7)])).toBeNull();
    expect(penetracaoMedia([])).toBeNull();
  });

  it('faixa: zero COM mercado é "sem_cliente"; sem denominador é "sem_dado"', () => {
    const media = penetracaoMedia(dados);
    expect(faixaPenetracao(dados[0], media)).toBe('abaixo');   // 0,5% < 0,8%
    expect(faixaPenetracao(dados[1], media)).toBe('acima');    // 2%
    expect(faixaPenetracao(dados[2], media)).toBe('sem_cliente');
    expect(faixaPenetracao(dados[3], media)).toBe('sem_dado');
    expect(faixaPenetracao(dados[0], null)).toBe('sem_dado');
  });

  it('oportunidades: abaixo da média, do maior mercado para o menor; sem denominador fica de fora', () => {
    expect(oportunidadesPenetracao(dados, 5).map((m) => m.municipio_codigo)).toEqual(['A', 'C']);
    expect(oportunidadesPenetracao(dados, 1).map((m) => m.municipio_codigo)).toEqual(['A']);
    expect(oportunidadesPenetracao([mun('D', null, null, 7)], 5)).toEqual([]);
  });

  it('formatação: null vira "—", zero vira "0,0%"', () => {
    expect(formatarPenetracao(null)).toBe('—');
    expect(formatarPenetracao(0)).toBe('0,0%');
    expect(formatarPenetracao(0.0053)).toBe('0,5%');
  });
});
