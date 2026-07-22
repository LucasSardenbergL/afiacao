import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — falha de carga NÃO pode virar KPI zerado.
 *
 * O helper `fetchAllPages` passou a LANÇAR quando uma página falha (antes devolvia o prefixo
 * parcial em silêncio). Isso conserta a mentira do NÚMERO, mas não a da TELA: com a query em
 * erro, `allScores` fica `undefined` e os KPIs caem nos `|| 0` espalhados pelos dois tabs.
 * "Total Clientes: 0", "LTV Projetado: R$ 0", "Concentração Top 20%: 0.0%" — cada um é uma
 * afirmação sobre o negócio produzida por uma falha de transporte nossa.
 *
 * Pior no StrategicTab, onde o `isLoading` do skeleton vem de `marginAudit` — OUTRA query. A de
 * scores podia falhar com a tela inteira renderizada como se estivesse tudo certo.
 *
 * O contrato desta suíte: sob falha, a tela diz que não sabe. Nunca zero, nunca skeleton eterno.
 */

type Resposta = { data: unknown; error: unknown };
let falharScores = false;

const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };

function resposta(table: string): Resposta {
  if (table === 'farmer_client_scores') {
    return falharScores ? { data: null, error: ERRO_PG } : { data: [], error: null };
  }
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'neq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order',
    'limit', 'range', 'or', 'filter', 'contains', 'single', 'maybeSingle',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: null }) },
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { IntelligenceManagerialTab } from '../IntelligenceManagerialTab';
import { IntelligenceStrategicTab } from '../IntelligenceStrategicTab';

// `retry: false` — o retry limitado é config global (App.tsx: retry 2 + backoff); aqui só
// interessa o ESTADO FINAL de erro, não a política de tentativa.
const renderWithClient = (ui: ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

beforeEach(() => { falharScores = true; vi.clearAllMocks(); });

describe('IntelligenceManagerialTab — falha de carga não vira "0 clientes"', () => {
  it('anuncia indisponibilidade em vez de renderizar os KPIs zerados', async () => {
    renderWithClient(<IntelligenceManagerialTab />);

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/indispon/i);
  });

  it('NÃO exibe "0" como total de clientes sob falha', async () => {
    renderWithClient(<IntelligenceManagerialTab />);
    await screen.findByRole('alert');

    // O KPI "Total Clientes" com `|| 0` afirmaria que a base tem zero cliente.
    const total = screen.queryByText('Total Clientes');
    if (total) {
      const card = total.closest('div')?.parentElement;
      expect(card?.textContent).not.toMatch(/\b0\b/);
    }
  });

  it('não fica em skeleton eterno (o erro resolve o carregamento)', async () => {
    const { container } = renderWithClient(<IntelligenceManagerialTab />);
    await screen.findByRole('alert');

    await waitFor(() => {
      expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBe(0);
    });
  });
});

describe('IntelligenceStrategicTab — falha de carga não vira LTV/CAC/Concentração zerados', () => {
  it('anuncia indisponibilidade dos KPIs derivados da base de scores', async () => {
    renderWithClient(<IntelligenceStrategicTab />);

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/indispon/i);
  });

  it('LTV, CAC e Concentração mostram "—", não R$ 0 / 0.0%', async () => {
    renderWithClient(<IntelligenceStrategicTab />);
    await screen.findByRole('alert');

    // Estes três derivam SÓ de `allScores`. Com a query em erro, o valor honesto é "—".
    for (const titulo of ['LTV Projetado (3a)', 'CAC Estimado', 'Concentração Top 20%']) {
      const el = screen.queryByText(titulo);
      expect(el, `KPI "${titulo}" sumiu da tela`).toBeTruthy();
      const card = el!.closest('div')?.parentElement;
      expect(card?.textContent, `KPI "${titulo}" exibiu zero fabricado`).toMatch(/—/);
    }
  });
});
