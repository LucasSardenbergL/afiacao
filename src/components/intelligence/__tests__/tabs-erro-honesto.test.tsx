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
let scoresRevenueAusente = false;

const ERRO_PG = { message: 'canceling statement due to statement timeout', code: '57014' };

// Leitura OK, mas revenue_potential ausente (a coluna órfã real de prod: sem produtor server-side).
// A Concentração não tem potencial pra concentrar → "—" (potencial não medido), nunca 0,0%.
const SCORES_SEM_REVENUE = [
  { customer_user_id: 'c1', gross_margin_pct: null, avg_monthly_spend_180d: 1000, avg_repurchase_interval: 5, revenue_potential: null },
  { customer_user_id: 'c2', gross_margin_pct: null, avg_monthly_spend_180d: 2000, avg_repurchase_interval: 8, revenue_potential: null },
];

function resposta(table: string): Resposta {
  if (table === 'farmer_client_scores') {
    if (falharScores) return { data: null, error: ERRO_PG };
    if (scoresRevenueAusente) return { data: SCORES_SEM_REVENUE, error: null };
    return { data: [], error: null };
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

beforeEach(() => { falharScores = true; scoresRevenueAusente = false; vi.clearAllMocks(); });

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

/**
 * Guard money-path — coluna ÓRFÃ (leitura OK, dado inexistente) ≠ erro de transporte.
 *
 * revenue_potential não tem produtor server-side: em prod é 0/null para toda a base. A leitura
 * SUCEDE (nenhum alerta de indisponibilidade), mas o KPI de Concentração calcularia 0/0. Exibir
 * "0,0%" afirmaria "carteira nada concentrada" — um número fabricado de um dado que não existe.
 * Contrato: nesse caso o KPI diz "—" com o motivo "potencial não medido" (distinto de "base
 * indisponível", que é o caso de erro acima).
 */
describe('IntelligenceStrategicTab — Concentração sob revenue_potential órfão', () => {
  beforeEach(() => { falharScores = false; scoresRevenueAusente = true; });

  it('mostra "—" (potencial não medido), não 0,0%, quando a leitura foi OK mas o potencial é ausente', async () => {
    renderWithClient(<IntelligenceStrategicTab />);

    const el = await screen.findByText('Concentração Top 20%');
    const card = el.closest('div')?.parentElement;
    // "—" com o motivo do órfão — e SEM alerta de "indisponível" (a base foi lida com sucesso).
    expect(card?.textContent, 'Concentração exibiu 0,0% fabricado').toMatch(/—/);
    expect(card?.textContent, 'faltou o motivo "potencial não medido"').toMatch(/não medido/);
    expect(screen.queryByRole('alert'), 'não devia anunciar indisponibilidade: a leitura sucedeu').toBeNull();
  });
});
