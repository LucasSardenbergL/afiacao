import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// "Alertas ativos" contava a tabela `eventos_outlier` inteira (511 com só 238 pendentes): aceitos,
// excluídos e resolvidos inflavam o número, e a lista de topo mostrava alertas já decididos. O selo
// procurava 'alta'/'critica', valores que não existem (o gravado é 'critico'), e nunca acendia.
// O mock não filtra: o filtro é provado pelo ARGUMENTO que chega ao PostgREST, e a ordem por quem
// devolve cada leitura por severidade.

type Chamada = { table: string; metodos: Array<[string, unknown[]]> };
type Linha = { id: number; tipo: string; sku_descricao: string | null; severidade: string };

let chamadas: Chamada[] = [];
let pendentesPorSeveridade: Record<string, Linha[]> = {};
let contagemPendentes = 0;

function chain(table: string): unknown {
  const registro: Chamada = { table, metodos: [] };
  chamadas.push(registro);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order', 'limit']) {
    c[m] = (...args: unknown[]) => {
      registro.metodos.push([m, args]);
      return c;
    };
  }
  c.then = (resolve: (v: unknown) => void) => {
    if (table !== 'eventos_outlier') return resolve({ data: [], error: null, count: 0 });
    const head = registro.metodos.some(([m, a]) => m === 'select' && (a[1] as { head?: boolean })?.head);
    if (head) return resolve({ data: null, error: null, count: contagemPendentes });
    const sev = registro.metodos.find(([m, a]) => m === 'eq' && a[0] === 'severidade')?.[1][1] as string;
    return resolve({ data: pendentesPorSeveridade[sev] ?? [], error: null });
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

const leiturasDeAlerta = () => chamadas.filter((c) => c.table === 'eventos_outlier');

beforeEach(() => {
  chamadas = [];
  contagemPendentes = 0;
  pendentesPorSeveridade = {};
});

describe('useReposicaoZone — alertas ativos', () => {
  it('conta só os pendentes, e toda leitura de alerta pede status pendente', async () => {
    contagemPendentes = 238;
    const { result } = montarHook();
    await waitFor(() => expect(result.current.kpis.length).toBeGreaterThan(0));
    expect(result.current.kpis[1]).toMatchObject({ label: 'Alertas ativos', value: '238' });
    const leituras = leiturasDeAlerta();
    expect(leituras.length).toBeGreaterThan(0);
    for (const l of leituras) expect(l.metodos).toContainEqual(['eq', ['status', 'pendente']]);
  });

  it('lista de topo: crítico antes de atenção antes de info, com selo nos dois primeiros', async () => {
    pendentesPorSeveridade = {
      info: [{ id: 3, tipo: 'venda_atipica', sku_descricao: 'FITA CREPE', severidade: 'info' }],
      atencao: [{ id: 2, tipo: 'sku_inativado_omie', sku_descricao: 'PINO F45', severidade: 'atencao' }],
      critico: [{ id: 1, tipo: 'lt_atipico', sku_descricao: 'BASE BRIL', severidade: 'critico' }],
    };
    const { result } = montarHook();
    await waitFor(() => expect(result.current.topItems).toHaveLength(3));
    expect(result.current.topItems.map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(result.current.topItems[0]).toMatchObject({
      subtitle: 'Lead time atípico · Crítico',
      badge: { label: 'crítico', intent: 'error' },
    });
    expect(result.current.topItems[1].badge).toEqual({ label: 'atenção', intent: 'warning' });
    expect(result.current.topItems[2].badge).toBeUndefined();
  });

  it('corta em 3 mesmo com várias críticas — atenção não entra', async () => {
    pendentesPorSeveridade = {
      critico: [1, 2, 3].map((id) => ({ id, tipo: 'venda_atipica', sku_descricao: `SKU ${id}`, severidade: 'critico' })),
      atencao: [{ id: 9, tipo: 'sku_sem_grupo', sku_descricao: 'OUTRO', severidade: 'atencao' }],
    };
    const { result } = montarHook();
    await waitFor(() => expect(result.current.topItems).toHaveLength(3));
    expect(result.current.topItems.map((i) => i.id)).toEqual(['1', '2', '3']);
  });
});
