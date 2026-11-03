import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Plano v5 E5 (lote 3): a leitura do aging descartava o `error` e fazia `if (!data) return 0`,
 * e os cards faziam `Number(x ?? 0)` — falha de RLS/rede/timeout virava "0,0%" de inadimplência
 * com borda neutra, e "R$ 0,00" a receber/pagar. Comportamental: o que o usuário VÊ em cada estado.
 */

type Resposta = { data: unknown; error: unknown };
let respostaAging: Resposta = { data: null, error: null };
const somar = vi.fn<(tabela: string) => Promise<number>>();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'maybeSingle']) c[m] = () => c;
      c.then = (resolve: (v: unknown) => void) => resolve(respostaAging);
      return c;
    },
  },
}));
vi.mock('@/services/financeiroService', () => ({
  somarSaldoAberto: (tabela: string) => somar(tabela),
}));
vi.mock('../FinanceiroDashboard', () => ({ default: () => null }));
vi.mock('../FinanceiroCapitalGiro', () => ({ default: () => null }));
vi.mock('../FinanceiroConciliacao', () => ({ default: () => null }));
vi.mock('../FinanceiroOrcamento', () => ({ default: () => null }));
vi.mock('../FinanceiroFechamento', () => ({ default: () => null }));

import FinanceiroGestao from '../FinanceiroGestao';

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FinanceiroGestao />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** O card é o ancestral que contém o rótulo e o valor. */
function card(rotulo: string): HTMLElement {
  const el = screen.getByText(rotulo).parentElement;
  if (!el) throw new Error(`card ${rotulo} sem container`);
  return el;
}

const zeroVencido = {
  a_vencer_valor: 1000,
  vencido_1_30_valor: 0,
  vencido_31_60_valor: 0,
  vencido_61_90_valor: 0,
  vencido_90_plus_valor: 0,
};

beforeEach(() => {
  somar.mockReset();
  respostaAging = { data: null, error: null };
});

describe('FinanceiroGestao — KPIs não fabricam zero', () => {
  it('erro na leitura do aging → "—" e aviso de falha, nunca "0,0%"', async () => {
    somar.mockResolvedValue(500);
    respostaAging = { data: null, error: { message: 'permission denied', code: '42501' } };
    montar();

    const inad = card('Inadimplência %');
    await waitFor(() => expect(within(inad).getByText('Falha ao carregar')).toBeTruthy());
    expect(within(inad).getByText('—')).toBeTruthy();
    expect(inad.textContent).not.toContain('0,0%');
    expect(inad.textContent).not.toContain('0.0%');
  });

  it('zero REAL (nada vencido, carteira aberta) → "0,0%"', async () => {
    somar.mockResolvedValue(500);
    respostaAging = { data: zeroVencido, error: null };
    montar();

    const inad = card('Inadimplência %');
    await waitFor(() => expect(within(inad).getByText('0,0%')).toBeTruthy());
    expect(within(inad).queryByText('Falha ao carregar')).toBeNull();
  });

  it('erro ao somar CR/CP → "—" nos cards de moeda, nunca "R$ 0,00"', async () => {
    somar.mockRejectedValue(new Error('timeout'));
    respostaAging = { data: zeroVencido, error: null };
    montar();

    for (const rotulo of ['Total a Receber', 'Total a Pagar']) {
      const c = card(rotulo);
      await waitFor(() => expect(within(c).getByText('Falha ao carregar')).toBeTruthy());
      expect(within(c).getByText('—')).toBeTruthy();
      expect(c.textContent).not.toMatch(/R\$\s*0,00/);
    }
  });

  it('carregando → skeleton, não "R$ 0,00"', () => {
    somar.mockReturnValue(new Promise<number>(() => {}));
    respostaAging = { data: zeroVencido, error: null };
    montar();

    const c = card('Total a Receber');
    expect(within(c).getByLabelText('Carregando Total a Receber')).toBeTruthy();
    expect(c.textContent).not.toMatch(/R\$\s*0,00/);
  });

  it('zero observado em CR → "R$ 0,00" (o zero real aparece)', async () => {
    somar.mockResolvedValue(0);
    respostaAging = { data: zeroVencido, error: null };
    montar();

    const c = card('Total a Receber');
    await waitFor(() => expect(c.textContent).toMatch(/R\$\s*0,00/));
  });
});
