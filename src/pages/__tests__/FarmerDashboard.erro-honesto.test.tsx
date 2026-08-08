import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — a falha do scoring tem de CHEGAR ao dashboard do farmer.
 *
 * O `useFarmerScoring` engolia a exceção num `console.error` e só encerrava o loading. Com o
 * `fetchAllPages` lançando em página perdida/malformada (#1581), esse buraco ficou mais
 * alcançável: em COLD LOAD com falha, `clientScores === []` e o dashboard renderiza "Saúde da
 * Carteira: 0 clientes" + "Nenhum cliente na agenda. Clique em 'Recalcular' para gerar" — dois
 * conselhos errados sobre um estado que não é o real. O farmer conclui que a carteira está
 * vazia; a verdade é que a leitura falhou.
 *
 * Contrato (§7 do money-path.md): sob falha SEM dado, a tela diz "indisponível" e oferece
 * retry; sob falha COM dado (ex.: troca de lente com o backend caindo), mantém o último estado
 * bom e avisa que está desatualizado.
 *
 * O hook roda de VERDADE (só o supabase é mockado): a cadeia leitura→scoring→tela é o que
 * precisa ser honesto — mockar o hook provaria apenas que a página renderiza um estado que eu
 * mesmo montei.
 */

const FARMER_A = 'farmer-a';

let falharScores = false;
let farmerAtual = FARMER_A;

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

// Um pedido de um cliente com profile: o suficiente para o scoring produzir 1 score e a agenda
// exibir "Cliente Um" (quota de risco).
const PEDIDOS = [{
  id: 'o1', customer_user_id: 'c1', items: [], total: 100,
  created_at: '2026-07-01T00:00:00Z', order_date_kpi: null, status: 'confirmado',
}];
const PERFIS = [{ user_id: 'c1', name: 'Cliente Um', phone: null }];

function resposta(table: string): unknown {
  if (table === 'sales_orders') {
    if (falharScores) return { data: null, error: ERRO_TIMEOUT };
    return { data: PEDIDOS, error: null };
  }
  if (table === 'profiles') return { data: PERFIS, error: null };
  return { data: [], error: null, count: 0 };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: farmerAtual }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: FARMER_A }, isStaff: true, loading: false }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import FarmerDashboard from '../FarmerDashboard';
import { TooltipProvider } from '@/components/ui/tooltip';

// SlaVencidoCard (filho) usa react-query e o card da agenda usa Tooltip — no app os dois
// providers vêm do App.tsx; aqui são infra do teste, não do contrato.
const renderDashboard = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <FarmerDashboard />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const utils = render(ui());
  return { ...utils, rerenderDashboard: () => utils.rerender(ui()) };
};

beforeEach(() => {
  falharScores = false;
  farmerAtual = FARMER_A;
  vi.clearAllMocks();
});

describe('FarmerDashboard — falha do scoring não vira "carteira vazia"', () => {
  it('DETECTOR: o caminho feliz renderiza a agenda e nenhum alerta', async () => {
    // Sem isto, "não achei o alerta" e "a tela nem montou" seriam indistinguíveis.
    renderDashboard();

    expect(await screen.findByText('Cliente Um')).toBeTruthy();
    expect(screen.getByText(/1 clientes/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('anuncia indisponibilidade + retry em vez de "Nenhum cliente na agenda"', async () => {
    falharScores = true;

    renderDashboard();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'o alerta não diz que a carteira está indisponível').toMatch(/indispon/i);
    // O empty state de sucesso manda "Recalcular para gerar" — sob falha isso afirma
    // "não existe" onde a verdade é "não consegui ler".
    expect(
      screen.queryByText(/Nenhum cliente na agenda/i),
      'afirmou carteira vazia onde a verdade é falha de leitura',
    ).toBeNull();
    // O resumo com "0 clientes" seria a mesma mentira em número.
    expect(screen.queryByText(/\b0 clientes\b/), 'exibiu "0 clientes" fabricado').toBeNull();
    expect(
      screen.getByRole('button', { name: /Tentar novamente/i }),
      'sem retry o farmer fica preso no estado de erro',
    ).toBeTruthy();
  });

  it('o retry recarrega de verdade: backend recuperado → agenda aparece', async () => {
    falharScores = true;

    renderDashboard();
    await screen.findByRole('alert');

    falharScores = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));

    expect(await screen.findByText('Cliente Um')).toBeTruthy();
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
  });

  it('mantém o último estado bom + aviso quando a troca de farmer falha a leitura', async () => {
    // Cenário real do stale: dados do farmer A na tela, lente troca para B, releitura falha.
    // Descartar o que está na mão trocaria uma mentira por outra; o contrato é manter + avisar.
    const { rerenderDashboard } = renderDashboard();
    await screen.findByText('Cliente Um');

    falharScores = true;
    farmerAtual = 'farmer-b';
    rerenderDashboard();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'nada avisa que os números são de antes').toMatch(/última leitura|desatualizad/i);
    expect(screen.getByText('Cliente Um'), 'descartou o último estado bom').toBeTruthy();
  });
});
