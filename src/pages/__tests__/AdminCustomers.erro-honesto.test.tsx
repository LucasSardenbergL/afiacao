import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard — a lista de clientes do admin não pode SUMIR como se estivesse vazia.
 *
 * No `useClientesScope`, `data === undefined` (query em erro) virava `customers = []` sem
 * nenhum `isError` exposto: a tela mostrava "Nenhum cliente na carteira" — indistinguível de
 * uma base genuinamente vazia. Para quem opera, "não há clientes" e "não consegui ler os
 * clientes" pedem ações opostas; a primeira mensagem sob falha é uma afirmação fabricada.
 *
 * Contrato (§7 do money-path.md): falha sem dado → estado de erro com retry; falha com dado
 * em cache (react-query preserva `data` através do refetch que falhou) → manter a lista e
 * avisar que pode estar desatualizada.
 *
 * O scope roda de VERDADE (modo "completa" — o caminho do buraco): só o supabase é mockado.
 */

let falharProfiles = false;

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

const PERFIS = [{
  user_id: 'c1', name: 'Cliente Um', email: 'c1@x.com', phone: null,
  document: null, customer_type: 'pj', created_at: '2026-07-01T00:00:00Z', requires_po: false,
}];

function resposta(table: string): unknown {
  if (table === 'profiles') {
    if (falharProfiles) return { data: null, error: ERRO_TIMEOUT, count: null };
    return { data: PERFIS, error: null, count: PERFIS.length };
  }
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
// `user` PRECISA ser o mesmo objeto entre renders: o AuthContext real guarda em `useState`
// (identidade estável), e `useAdminCustomers` tem `useEffect(…, [user, isStaff])` que chama
// `setCategories`. Um literal novo a cada chamada — como estava — dá dep sempre "nova" →
// efeito → setState → render → efeito: loop infinito de render, e o teste TRAVA (não falha).
// Mock instável = infra de teste divergindo da realidade, não bug do código sob teste.
// (o objeto nasce DENTRO da factory: `vi.mock` é içado para o topo do arquivo, então
// referenciar um const de fora cairia na TDZ — o closure roda uma vez e é estável.)
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'staff-1' };
  return { useAuth: () => ({ user, isStaff: true, loading: false }) };
});
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: 'staff-1' }),
}));
// Master → modo "completa" (base inteira paginada) — o caminho onde o erro virava lista vazia.
vi.mock('@/hooks/useDisplayAccess', () => ({
  useDisplayAccess: () => ({
    displayIsMaster: true, displayIsGestorComercial: false,
    displayIsSalesOnly: false, displayLoading: false,
  }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import AdminCustomers from '../AdminCustomers';

const renderPage = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/customers']}>
        <AdminCustomers />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { qc, ...render(ui()) };
};

beforeEach(() => {
  falharProfiles = false;
  vi.clearAllMocks();
});

describe('AdminCustomers — falha de leitura não vira "Nenhum cliente na carteira"', () => {
  it('DETECTOR: o caminho feliz renderiza a lista e nenhum alerta', async () => {
    renderPage();

    expect(await screen.findByText('Cliente Um')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('anuncia a falha + retry em vez do empty state de base vazia', async () => {
    falharProfiles = true;

    renderPage();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'o alerta não diz que a leitura falhou').toMatch(/não foi possível|indispon/i);
    expect(
      screen.queryByText(/Nenhum cliente na carteira/i),
      'afirmou "base vazia" onde a verdade é "não consegui ler"',
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /Tentar novamente/i }),
      'sem retry o operador fica preso no estado de erro',
    ).toBeTruthy();
  });

  it('o retry recarrega de verdade: backend recuperado → lista aparece', async () => {
    falharProfiles = true;

    renderPage();
    await screen.findByRole('alert');

    falharProfiles = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));

    expect(await screen.findByText('Cliente Um')).toBeTruthy();
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
  });

  it('mantém a lista + aviso de desatualização quando o refetch falha com dado na mão', async () => {
    const { qc } = renderPage();
    await screen.findByText('Cliente Um');

    falharProfiles = true;
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['admin-clientes-base'] });
    });

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'nada avisa que a lista é de antes').toMatch(/última leitura|desatualizad/i);
    expect(screen.getByText('Cliente Um'), 'descartou o último estado bom').toBeTruthy();
  });
});
