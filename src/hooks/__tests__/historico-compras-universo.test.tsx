import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// O universo de VENDA vai na QUERY — o banco filtra ANTES do LIMIT. O filtro em memória que existia
// (com uma cópia da lista sem `pendente`) rodava sobre a janela já cortada: cada cancelado nela tirava
// um pedido válido. Ordem dos métodos na cadeia não importa (viram parâmetros da mesma URL); o que
// importa é o par estar NA query e o limit ser a janela final, sem sobra para compensar refiltro.

type Chamada = { table: string; metodos: Array<[string, unknown[]]> };
let chamadas: Chamada[] = [];
let pedidos: unknown[] = [];

function chain(table: string): unknown {
  const registro: Chamada = { table, metodos: [] };
  chamadas.push(registro);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'not', 'in', 'order', 'limit']) {
    c[m] = (...args: unknown[]) => {
      registro.metodos.push([m, args]);
      return c;
    };
  }
  c.then = (resolve: (v: unknown) => void) => resolve({ data: table === 'sales_orders' ? pedidos : [], error: null });
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));

import { useHistoricoCompras } from '../useHistoricoCompras';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useHistoricoCompras('c1'), { wrapper });
}

describe('useHistoricoCompras — o universo de venda antes do limit', () => {
  beforeEach(() => {
    chamadas = [];
    pedidos = [];
  });

  it('a query carrega o par canônico e o limit(50) é a janela final', async () => {
    pedidos = [{ id: 'p1', order_date_kpi: '2026-09-30', created_at: '2026-09-30T12:00:00Z', total: 100 }];
    const { result } = montar();
    await waitFor(() => expect(result.current.historico).not.toBeNull());
    const m = chamadas.find((c) => c.table === 'sales_orders')?.metodos ?? [];
    expect(m, 'falta o .not(status, in, STATUS_NAO_VENDA_POSTGREST) na query').toContainEqual(['not', ['status', 'in', STATUS_NAO_VENDA_POSTGREST]]);
    expect(m, 'falta o .is(deleted_at, null) na query').toContainEqual(['is', ['deleted_at', null]]);
    // o CORTE é por recência: o eixo e a direção são parte da régua (inverter o ascending entregaria os mais antigos)
    expect(m, 'critério de ordenação do corte mudou').toContainEqual(['order', ['order_date_kpi', { ascending: false, nullsFirst: false }]]);
    expect(m.filter(([nome]) => nome === 'limit')).toEqual([['limit', [50]]]);
  });
});
