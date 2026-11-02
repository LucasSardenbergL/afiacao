import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// Plano v4, lote 5 — N1. A Governança só precisa da config do algoritmo; antes ela a lia via
// `useFarmerScoring()`, que monta o motor e baixa TODO o histórico de `sales_orders` (~32k linhas
// em ~33 páginas) para uma carteira que a tela não mostra. E a leitura de config que falhava caía
// calada no default — que a proposta gravava em `current_params` como se fosse o valor vigente.

type Resposta = { data: unknown; error: unknown };

const ERRO_PG = { message: 'permission denied for table farmer_algorithm_config', code: '42501' };

let tabelasLidas: string[] = [];
let leituraConfig: 'ok' | 'erro' = 'ok';

function chain(table: string): unknown {
  tabelasLidas.push(table);
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'gte', 'lt', 'in', 'not', 'is', 'or', 'order', 'limit', 'range']) c[m] = () => c;
  c.then = (resolve: (v: Resposta) => void) => {
    if (table === 'farmer_algorithm_config') {
      if (leituraConfig === 'erro') return resolve({ data: null, error: ERRO_PG });
      return resolve({ data: [{ key: 'k1', value: 2.5 }], error: null });
    }
    return resolve({ data: [], error: null });
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => chain(t), rpc: () => chain('rpc') },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-gov' }, isStaff: true, isMaster: false, loading: false }),
}));
// Não são usados pela página: existem para que, SE o motor voltar a montar, ele chegue até a leitura
// de `sales_orders` e o teste fique vermelho pelo motivo certo — não por falta de provider
// (falsificado: sem estes mocks a sabotagem reprovava por `useImpersonation deve estar dentro…`).
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ effectiveUserId: 'u-gov' }) }));
vi.mock('@/hooks/useCommercialRole', () => ({ useCommercialRole: () => ({ canViewManagerial: true, loading: false }) }));
vi.mock('@/hooks/useFarmerGovernance', () => ({
  useFarmerGovernance: () => ({
    proposals: [],
    auditLogs: [],
    loading: false,
    isGovernor: false,
    createProposal: vi.fn(),
    approveProposal: vi.fn(),
    rejectProposal: vi.fn(),
  }),
}));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));

import FarmerGovernance from '../FarmerGovernance';

function montar() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <FarmerGovernance />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const botaoNovaProposta = () => screen.getByRole('button', { name: /Nova Proposta de Ajuste/ });

beforeEach(() => {
  tabelasLidas = [];
  leituraConfig = 'ok';
});

describe('FarmerGovernance — lê só a config', () => {
  it('não dispara a leitura de sales_orders (nem o motor de scoring)', async () => {
    montar();
    await waitFor(() => expect(botaoNovaProposta()).not.toBeDisabled());
    expect(tabelasLidas).toContain('farmer_algorithm_config');
    expect(tabelasLidas).not.toContain('sales_orders');
    expect(tabelasLidas).not.toContain('farmer_calls');
  });

  it('o "valor atual" da proposta é o do BANCO, mesclado ao default como o motor faz', async () => {
    montar();
    await waitFor(() => expect(botaoNovaProposta()).not.toBeDisabled());
    fireEvent.click(botaoNovaProposta());
    const linhaK1 = (await screen.findByText('k1 (ChurnRisk decay)')).parentElement as HTMLElement;
    expect(linhaK1.textContent).toContain('2.5');
    // chave ausente no banco = default do motor (k2 = 1)
    const linhaK2 = screen.getByText('k2 (RF decay)').parentElement as HTMLElement;
    expect(linhaK2.textContent).toContain('1');
  });

  it('leitura da config falhou: aviso de erro e nova proposta TRAVADA — nunca o default como vigente', async () => {
    leituraConfig = 'erro';
    montar();
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(botaoNovaProposta()).toBeDisabled();
  });
});
