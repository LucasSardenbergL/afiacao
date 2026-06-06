import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Guard de regressão da lente "Ver como pessoa" nas telas de ATIVIDADE do vendedor
 * (cards do dashboard "Meu Dia"). Estas leituras devem filtrar pelo id EFETIVO:
 * o ALVO na lente, o próprio usuário fora dela. Captura todo `.eq(col, valor)` do
 * stub do supabase e verifica que o id filtrado segue a lente.
 */
const eqCalls: Array<[string, unknown]> = [];

function stubChain(): unknown {
  const chain: Record<string, unknown> = {};
  const passthrough = [
    'select', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order',
    'limit', 'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
  ];
  for (const m of passthrough) chain[m] = () => chain;
  chain.eq = (col: string, val: unknown) => { eqCalls.push([col, val]); return chain; };
  // thenable: qualquer `await chain` resolve vazio (a lógica vive em helpers puros já testados)
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
  return chain;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => stubChain() } }));

const impMock = vi.fn();
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'master-id' } }) }));

import { useKpisVisita } from '../useKpisVisita';
import { useMyKpis } from '../useMyKpis';
import { useFollowupsVisita } from '../useFollowupsVisita';
import { useMinhasVisitasResultado } from '../useMinhasVisitasResultado';

let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

beforeEach(() => {
  eqCalls.length = 0;
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

// Os hooks são chamados via renderHook (contexto de render válido); o lint não enxerga
// a indireção `run`, então desligamos a regra localmente neste array de casos.
/* eslint-disable react-hooks/rules-of-hooks */
const hooks: Array<{ name: string; run: () => unknown }> = [
  { name: 'useKpisVisita', run: () => useKpisVisita(30) },
  { name: 'useMyKpis', run: () => useMyKpis() },
  { name: 'useFollowupsVisita', run: () => useFollowupsVisita() },
  { name: 'useMinhasVisitasResultado', run: () => useMinhasVisitasResultado(30) },
];
/* eslint-enable react-hooks/rules-of-hooks */

for (const h of hooks) {
  describe(`${h.name} — lente "Ver como"`, () => {
    it('na lente: filtra pelo id do ALVO, nunca o do master', async () => {
      impMock.mockReturnValue({ isImpersonating: true, effectiveUserId: 'alvo-id' });
      renderHook(h.run, { wrapper });
      await waitFor(() => expect(eqCalls.length).toBeGreaterThan(0));
      const valores = eqCalls.map((c) => c[1]);
      expect(valores).toContain('alvo-id');
      expect(valores).not.toContain('master-id');
    });

    it('fora da lente: filtra pelo próprio usuário', async () => {
      impMock.mockReturnValue({ isImpersonating: false, effectiveUserId: 'master-id' });
      renderHook(h.run, { wrapper });
      await waitFor(() => expect(eqCalls.length).toBeGreaterThan(0));
      expect(eqCalls.map((c) => c[1])).toContain('master-id');
    });
  });
}
