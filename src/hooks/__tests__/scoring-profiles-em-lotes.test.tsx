import { describe, it, expect, vi, beforeEach } from 'vitest';
import { comQueryClient } from '@/test/query-client';
import { renderHook, act, waitFor } from '@testing-library/react';

/**
 * Os profiles da carteira acima da capa de 1.000 (plano v9, C18).
 *
 * `useFarmerScoring` lia os profiles de TODOS os clientes distintos do universo de `sales_orders`
 * numa request só, sem `.range()` e descartando o `error`. Em prod (11/11/2026): 1.245 clientes,
 * 1.214 com profile. O PostgREST devolvia 1.000 e o `if (!profile) return` tirava os outros 214
 * do score, sem erro. E se a request falhasse (a URL tinha ~46 KB), o `?? []` apagava a carteira.
 *
 * O stub reproduz o TRANSPORTE, não só o dado: SEM `.range()` a resposta vem capada em 1.000, com
 * `.range()` devolve a fatia, e o `.in()` filtra de verdade. Um stub que devolvesse tudo não
 * provaria nada (o golden de `universo-pedidos-golden.ts` gera 160 clientes e não simula a capa;
 * ele continua valendo para a equivalência do cálculo, este arquivo cobre o transporte).
 *
 * O cenário espelha a prod: 1.245 clientes, 31 deles sem profile (os aliases fiscais
 * `@placeholder.local` do grupo, que não têm `profiles` e não podem abortar a leitura).
 */

const CAPA = 1000;
const N_CLIENTES = 1245;
const N_SEM_PROFILE = 31;
/** Teto de UUIDs por `.in`: 200 já chegam perto de 8 KB de URL (parecer do Codex, v9 C18). */
const TETO_URL_SEGURO = 150;

const cid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const CLIENTES = Array.from({ length: N_CLIENTES }, (_, i) => cid(i));
/** Os sem profile ficam espalhados (a cada 40), não só na cauda: a falta não depende da posição. */
const SEM_PROFILE = new Set(CLIENTES.filter((_, i) => i % 40 === 7).slice(0, N_SEM_PROFILE));

type Falha = { tabela: 'profiles' | 'farmer_calls'; naRequisicao: number; modo: 'erro' | 'data_null' } | null;
let falha: Falha = null;
const requisicoes: Record<string, number> = {};
const tamanhosDoIn: number[] = [];

function linhasDe(tabela: string): Record<string, unknown>[] {
  if (tabela === 'profiles') {
    return CLIENTES.filter((c) => !SEM_PROFILE.has(c)).map((c, i) => ({ user_id: c, name: `Cliente ${i}`, phone: null }));
  }
  if (tabela === 'farmer_calls') {
    // Ligação de 3 dias atrás para o 1º cliente: prova que a leitura chegou ao score.
    const ontem = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    return [{ id: 'call-1', customer_user_id: CLIENTES[0], call_result: 'contato_sucesso', is_whatsapp: false, whatsapp_replied: false, created_at: ontem }];
  }
  return [];
}

function stubChain(tabela: string): unknown {
  const n = (requisicoes[tabela] = (requisicoes[tabela] ?? 0) + 1) - 1;
  let filtroIn: { col: string; vals: Set<unknown> } | null = null;
  let ordem: string | null = null;
  let faixa: [number, number] | null = null;
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'limit', 'or', 'neq', 'filter']) chain[m] = () => chain;
  chain.in = (col: string, vals: unknown[]) => {
    filtroIn = { col, vals: new Set(vals) };
    if (tabela === 'profiles') tamanhosDoIn.push(vals.length);
    return chain;
  };
  chain.order = (col: string) => { ordem = col; return chain; };
  chain.range = (de: number, ate: number) => { faixa = [de, ate]; return chain; };
  chain.single = () => ({ then: (r: (v: unknown) => void) => r({ data: null, error: null }) });
  chain.maybeSingle = chain.single;
  chain.then = (resolve: (v: unknown) => void) => {
    if (falha && falha.tabela === tabela && falha.naRequisicao === n) {
      return resolve(falha.modo === 'erro'
        ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
        : { data: null, error: null });
    }
    let linhas = linhasDe(tabela);
    if (filtroIn) {
      const { col, vals } = filtroIn;
      linhas = linhas.filter((l) => vals.has(l[col]));
    }
    if (ordem) {
      const col = ordem;
      linhas = [...linhas].sort((a, b) => String(a[col]).localeCompare(String(b[col])));
    }
    // A capa do PostgREST: sem `.range()`, as 1.000 primeiras — em silêncio.
    linhas = faixa ? linhas.slice(faixa[0], faixa[1] + 1) : linhas.slice(0, CAPA);
    return resolve({ data: linhas, error: null, count: linhas.length });
  };
  return chain;
}

const pedido = (c: string, i: number) => ({
  id: `ped-${String(i).padStart(5, '0')}`,
  customer_user_id: c,
  items: [],
  total: 1000 + i,
  created_at: '2026-10-01T00:00:00Z',
  order_date_kpi: '2026-10-01',
  status: 'faturado',
});

vi.mock('@/lib/farmer/universo-pedidos-query', async (orig) => ({
  ...(await orig<typeof import('@/lib/farmer/universo-pedidos-query')>()),
  buscarUniversoPedidos: async () => CLIENTES.map(pedido),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => stubChain(tabela),
    rpc: () => {
      const chain: Record<string, unknown> = {};
      chain.order = () => chain;
      chain.range = () => chain;
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return chain;
    },
  },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'gestor-1' }, isMaster: true, isStaff: true }) }));
vi.mock('@/hooks/useCommercialRole', () => ({ useCommercialRole: () => ({ canViewManagerial: true, loading: false }) }));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: 'gestor-1' }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
// O catch do hook loga o erro; aqui ele é o esperado, não ruído de teste.
vi.spyOn(console, 'error').mockImplementation(() => {});

import { useFarmerScoring } from '../useFarmerScoring';

async function montarECalcular() {
  const hook = renderHook(() => useFarmerScoring(), { wrapper: comQueryClient() });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => { await hook.result.current.recalculate(); });
  return hook;
}

beforeEach(() => {
  falha = null;
  for (const k of Object.keys(requisicoes)) delete requisicoes[k];
  tamanhosDoIn.length = 0;
});

describe('useFarmerScoring — profiles acima da capa de 1.000', () => {
  it('pontua os 1.214 clientes com profile, não os 1.000 que a capa deixava', async () => {
    const { result } = await montarECalcular();

    expect(result.current.erro).toBeNull();
    expect(result.current.clientScores).toHaveLength(N_CLIENTES - N_SEM_PROFILE);
    // O último cliente do universo é justamente o que a capa comia.
    expect(result.current.clientScores.some((s) => s.customer_user_id === cid(N_CLIENTES - 1))).toBe(true);
  });

  it('o cliente sem profile (alias fiscal) fica fora do score SEM abortar a leitura', async () => {
    const { result } = await montarECalcular();

    expect(result.current.erro).toBeNull();
    const ids = new Set(result.current.clientScores.map((s) => s.customer_user_id));
    for (const semProfile of SEM_PROFILE) expect(ids.has(semProfile)).toBe(false);
  });

  it('cada `.in` cabe na URL: nenhum lote passa do teto seguro e a soma cobre todos os clientes', async () => {
    await montarECalcular();

    expect(tamanhosDoIn.length).toBeGreaterThan(1);
    expect(Math.max(...tamanhosDoIn)).toBeLessThanOrEqual(TETO_URL_SEGURO);
    // Uma chamada de `recalculate` além da montagem: a soma de UMA rodada é o universo inteiro.
    const porRodada = tamanhosDoIn.slice(0, tamanhosDoIn.length / 2);
    expect(porRodada.reduce((a, b) => a + b, 0)).toBe(N_CLIENTES);
  });

  it('a ligação lida em `farmer_calls` chega ao score do cliente', async () => {
    const { result } = await montarECalcular();

    const primeiro = result.current.clientScores.find((s) => s.customer_user_id === CLIENTES[0]);
    expect(primeiro?.answerRate60d).toBe(100);
  });

  it.each([
    ['erro de transporte', 'erro' as const],
    ['resposta malformada (data null sem error)', 'data_null' as const],
  ])('falha num lote do MEIO de profiles (%s) declara o erro e preserva o último resultado bom', async (_, modo) => {
    const { result } = await montarECalcular();
    expect(result.current.clientScores).toHaveLength(N_CLIENTES - N_SEM_PROFILE);

    // 13 lotes por rodada; a 2ª rodada (o recalculate abaixo) começa onde a anterior parou.
    const lotesPorRodada = requisicoes.profiles / 2;
    falha = { tabela: 'profiles', naRequisicao: requisicoes.profiles + Math.floor(lotesPorRodada / 2), modo };
    await act(async () => { await result.current.recalculate(); });

    expect(result.current.erro).not.toBeNull();
    // Sem o fail-closed, a rodada publicaria só os clientes dos lotes que voltaram.
    expect(result.current.clientScores).toHaveLength(N_CLIENTES - N_SEM_PROFILE);
  });

  it.each([
    ['erro de transporte', 'erro' as const],
    ['resposta malformada (data null sem error)', 'data_null' as const],
  ])('falha em `farmer_calls` (%s) declara o erro em vez de zerar a taxa de contato', async (_, modo) => {
    const { result } = await montarECalcular();
    const antes = result.current.clientScores.find((s) => s.customer_user_id === CLIENTES[0]);
    expect(antes?.answerRate60d).toBe(100);

    falha = { tabela: 'farmer_calls', naRequisicao: requisicoes.farmer_calls, modo };
    await act(async () => { await result.current.recalculate(); });

    expect(result.current.erro).not.toBeNull();
    const depois = result.current.clientScores.find((s) => s.customer_user_id === CLIENTES[0]);
    expect(depois?.answerRate60d).toBe(100);
  });
});
