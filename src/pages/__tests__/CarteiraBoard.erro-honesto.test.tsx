import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — a falha do scoring tem de CHEGAR ao board da carteira.
 *
 * Buraco (classe #1565→#1579→#1697, consumidor que ficou de fora): o board destruturava
 * `{ agenda, clientScores, loading }` e ignorava o `erro` que o hook JÁ expõe desde o #1697.
 * Sob falha de leitura, `agenda === []` e `montarColunasBoard([], [], [])` devolve as três
 * colunas VAZIAS — e o `BoardCarteira` renderiza "Nada aqui / Sem clientes nesta coluna" em
 * cada uma. O `loading` já virou false (o `finally` do hook encerra), então nem skeleton
 * sobra: a tela afirma, com cara de sucesso, que não há cliente em risco, em expansão nem em
 * follow-up. Para quem opera, "sem ninguém em risco" e "não consegui ler a carteira" pedem
 * ações OPOSTAS — a primeira é uma afirmação fabricada.
 *
 * Contrato (§7 do money-path.md): falha → retry → último dado bom + aviso de stale; sem cache
 * → "indisponível" com o motivo. Nunca zero fabricado, nunca skeleton eterno.
 *
 * O hook roda de VERDADE (só o supabase é mockado): a cadeia leitura→scoring→board é o que
 * precisa ser honesto — mockar o hook provaria só que a página renderiza o estado que eu montei.
 */

const FARMER_A = 'farmer-a';

let falharScores = false;
let falharSla = false;

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

const PEDIDOS = [{
  id: 'o1', customer_user_id: 'c1', items: [], total: 100,
  created_at: '2026-07-01T00:00:00Z', order_date_kpi: null, status: 'confirmado',
}];
const PERFIS = [{ user_id: 'c1', name: 'Cliente Um', phone: null }];
const FAIXAS = [{ customer_user_id: 'c1', faixa: 'verde', motivo: 'saudavel', g: 0.8, margem_pct: null }];
const CARTEIRA = [{ customer_user_id: 'c1' }];
const SLA = [{
  customer_user_id: 'c1', farmer_id: FARMER_A, health_class: 'saudavel', churn_risk: 20,
  last_contact_at: null, dias_sem_contato: 9, sla_dias: 7, vencido: true, priority_score: 5,
}];

function resposta(table: string): unknown {
  if (table === 'sales_orders') {
    if (falharScores) return { data: null, error: ERRO_TIMEOUT };
    return { data: PEDIDOS, error: null };
  }
  if (table === 'profiles') return { data: PERFIS, error: null };
  if (table === 'carteira_assignments') return { data: CARTEIRA, error: null };
  if (table === 'v_carteira_sla') {
    if (falharSla) return { data: null, error: ERRO_TIMEOUT };
    return { data: SLA, error: null };
  }
  return { data: [], error: null, count: 0 };
}

function respostaRpc(fn: string): unknown {
  if (fn === 'get_carteira_margem_faixa') {
    if (falharScores) return { data: null, error: ERRO_TIMEOUT };
    return { data: FAIXAS, error: null };
  }
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains', 'returns',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (fn: string) => {
      const r = respostaRpc(fn);
      // A leitura de faixas é PAGINADA (`fetchAllPages`) e o builder de `.rpc()` expõe
      // `.order()`/`.range()` como o de `.from()` — o dublê precisa expor também.
      const c: Record<string, unknown> = {
        order: () => c,
        range: () => c,
        then: (resolve: (v: unknown) => void) => resolve(r),
      };
      return c;
    },
  },
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: 'farmer-a' }),
}));
// `user` nasce DENTRO da factory: `vi.mock` é içado, então um const de fora cairia na TDZ. E
// precisa ser o MESMO objeto entre renders — identidade nova a cada chamada já custou um teste
// que TRAVAVA em loop de render (lição do #1697, AdminCustomers.erro-honesto).
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'farmer-a' };
  return { useAuth: () => ({ user, isStaff: true, isMaster: false, loading: false }) };
});
vi.mock('@/hooks/useCommercialRole', () => ({
  useCommercialRole: () => ({ canViewManagerial: false, loading: false }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import CarteiraBoard from '../CarteiraBoard';

const renderBoard = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CarteiraBoard />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { qc, ...render(ui()) };
};

/** "Nada aqui" é o empty state de SUCESSO do BoardCarteira (coluna sem cliente). */
const colunasVazias = () => screen.queryAllByText(/Nada aqui/i);

beforeEach(() => {
  falharScores = false;
  falharSla = false;
  vi.clearAllMocks();
});

describe('CarteiraBoard — falha de leitura não vira "board vazio"', () => {
  it('DETECTOR: o caminho feliz monta o card e não alerta nada', async () => {
    renderBoard();

    expect(await screen.findByText('Cliente Um')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('DETECTOR: o seletor de coluna vazia enxerga um empty state VIVO', async () => {
    // Sem este par, `colunasVazias().length === 0` no teste de erro passaria com um seletor
    // morto (a armadilha que o #1585 documentou). Aqui a agenda tem só um card, logo as outras
    // colunas ficam legitimamente vazias — e o seletor TEM de achá-las.
    renderBoard();

    await screen.findByText('Cliente Um');
    expect(colunasVazias().length).toBeGreaterThan(0);
  });

  it('sob falha SEM dado: alerta com motivo + retry, e nenhuma coluna afirmando "Nada aqui"', async () => {
    falharScores = true;

    renderBoard();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'o alerta não diz que a leitura falhou').toMatch(/não foi possível|indispon/i);
    expect(
      colunasVazias().length,
      'afirmou "sem clientes nesta coluna" sobre uma carteira que NÃO foi lida',
    ).toBe(0);
    expect(
      screen.getByRole('button', { name: /Tentar novamente/i }),
      'sem retry o operador fica preso no estado de erro',
    ).toBeTruthy();
  });

  it('o retry recarrega de verdade: backend recuperado → board aparece', async () => {
    falharScores = true;

    renderBoard();
    await screen.findByRole('alert');

    falharScores = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));

    expect(await screen.findByText('Cliente Um')).toBeTruthy();
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
  });

  it('a falha do SLA é declarada em vez de virar board sem marca de atraso', async () => {
    // `slaRows ?? []` apagava a falha do v_carteira_sla: o board renderia INTEIRO, com cara de
    // sucesso, e todo card viria `slaVencido: false` — "ninguém atrasado" fabricado. Mesmo
    // anti-padrão do §7 (skeleton/zeros vindos de OUTRA query que a tela não declara).
    falharSla = true;

    renderBoard();

    await screen.findByText('Cliente Um');
    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/atraso|SLA/i);
  });
});
