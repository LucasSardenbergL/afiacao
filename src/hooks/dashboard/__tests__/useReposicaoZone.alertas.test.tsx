import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Card Reposição do Dashboard. Histórico:
// - "Alertas ativos" contava a tabela `eventos_outlier` inteira (511 com só 238 pendentes) → filtro status.
// - Mesmo filtrado, 142 dos 236 pendentes eram venda atípica, que é REGISTRO (aceitar não move o motor):
//   o KPI vira "Pendências" e conta só os tipos da Fila (sku_sem_grupo, lt_atipico).
// - A lista de topo mostrava venda atípica "crítica" (= pedido grande, não risco) e o clique caía numa visão
//   que nem exibia o item: agora lista os pedidos aguardando aprovação, cada um abrindo o PRÓPRIO detalhe.
// O mock não filtra: o filtro é provado pelo ARGUMENTO que chega ao PostgREST.

type Chamada = { table: string; metodos: Array<[string, unknown[]]> };
type Sugerido = { id: number; fornecedor_nome: string | null; empresa: string; valor_total: number | null; num_skus: number | null };

let chamadas: Chamada[] = [];
let sugeridos: Sugerido[] = [];
let contagemPendencias = 0;

function chain(table: string): unknown {
  const registro: Chamada = { table, metodos: [] };
  chamadas.push(registro);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit']) {
    c[m] = (...args: unknown[]) => {
      registro.metodos.push([m, args]);
      return c;
    };
  }
  c.then = (resolve: (v: unknown) => void) => {
    const head = registro.metodos.some(([m, a]) => m === 'select' && (a[1] as { head?: boolean })?.head);
    if (table === 'eventos_outlier') return resolve({ data: null, error: null, count: contagemPendencias });
    if (table === 'pedido_compra_sugerido' && !head) return resolve({ data: sugeridos, error: null });
    return resolve({ data: null, error: null, count: 0 });
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock('@/hooks/useDashboardCompany', () => ({
  useDashboardCompany: () => ({ companies: ['oben'], mode: 'single', primary: 'oben' }),
}));
vi.mock('@/hooks/dashboard/useCockpitChannel', () => ({ useCockpitChannel: () => ({ isLive: false }) }));

import { useReposicaoZone } from '../useReposicaoZone';

function montarHook() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useReposicaoZone(), { wrapper });
}

beforeEach(() => {
  chamadas = [];
  contagemPendencias = 0;
  sugeridos = [];
});

describe('useReposicaoZone — pendências', () => {
  it('conta só pendentes dos tipos que pedem decisão (venda atípica fica fora)', async () => {
    contagemPendencias = 11;
    const { result } = montarHook();
    await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
    expect(result.current.kpis[1]).toMatchObject({ label: 'Pendências', value: '11' });
    const leituras = chamadas.filter((c) => c.table === 'eventos_outlier');
    expect(leituras).toHaveLength(1);
    expect(leituras[0].metodos).toContainEqual(['eq', ['status', 'pendente']]);
    expect(leituras[0].metodos).toContainEqual(['in', ['tipo', ['sku_sem_grupo', 'lt_atipico']]]);
  });
});

describe('useReposicaoZone — lista de topo = pedidos aguardando aprovação', () => {
  it('lê só pendente_aprovacao, no máximo 3, e cada item abre o próprio pedido', async () => {
    sugeridos = [
      { id: 4559, fornecedor_nome: 'BAUNGARTEN', empresa: 'OBEN', valor_total: 3560.84, num_skus: 2 },
      { id: 4558, fornecedor_nome: 'ACRE CAXIAS', empresa: 'OBEN', valor_total: 4426.37, num_skus: 1 },
    ];
    const { result } = montarHook();
    await waitFor(() => expect(result.current.topItems).toHaveLength(2));
    const leitura = chamadas.find(
      (c) => c.table === 'pedido_compra_sugerido' && c.metodos.some(([m, a]) => m === 'select' && !(a[1] as { head?: boolean })?.head),
    );
    expect(leitura?.metodos).toContainEqual(['eq', ['status', 'pendente_aprovacao']]);
    expect(leitura?.metodos).toContainEqual(['limit', [3]]);
    expect(result.current.topItems[0]).toMatchObject({
      id: '4559',
      title: 'BAUNGARTEN',
      path: '/admin/reposicao/pedidos?id=4559',
      itemType: 'pedido_compra_sugerido',
    });
    expect(result.current.topItems[0].subtitle).toMatch(/^Aguardando aprovação · OBEN · 2 SKUs · R\$\s?3\.561$/);
    expect(result.current.topItems[1].subtitle).toContain('1 SKU ·');
    expect(result.current.topItems[0].badge).toBeUndefined();
  });

  it('valor e SKUs ausentes somem da linha — nunca viram "R$ 0"/"0 SKUs"', async () => {
    sugeridos = [{ id: 7, fornecedor_nome: null, empresa: 'COLACOR', valor_total: null, num_skus: null }];
    const { result } = montarHook();
    await waitFor(() => expect(result.current.topItems).toHaveLength(1));
    expect(result.current.topItems[0]).toMatchObject({ title: 'Pedido #7', subtitle: 'Aguardando aprovação · COLACOR' });
  });
});
