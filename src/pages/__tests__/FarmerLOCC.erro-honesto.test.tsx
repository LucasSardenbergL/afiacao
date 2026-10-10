import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — a falha do scoring tem de CHEGAR ao LOCC.
 *
 * Buraco (classe #1565→#1579→#1697, consumidor que ficou de fora): a página destruturava
 * `{ summary, loading, calculating, recalculate, config }` e ignorava o `erro` que o hook JÁ
 * expõe desde o #1697. O `summary` é o pior caso da classe porque ele FABRICA o número
 * explicitamente — `useFarmerScoring` tem, literal, `if (clientScores.length === 0) return
 * { totalClients: 0, avgHealth: 0, saudavel: 0, estavel: 0, atencao: 0, critico: 0 }`. Sob
 * falha de leitura `clientScores === []`, então o "Motor de Diagnóstico" exibe quatro zeros e
 * "Health Score Médio 0", com a barra de progresso em 0 — números de decisão inventados por
 * uma falha de transporte. É o `Number(null) === 0` do CLAUDE.md: ausente ≠ zero.
 *
 * Contrato (§7 do money-path.md): falha → retry → último dado bom + aviso de stale; sem cache
 * → "indisponível" com o motivo. Nunca zero fabricado, nunca skeleton eterno.
 *
 * O hook roda de VERDADE (só o supabase é mockado): a cadeia leitura→scoring→tela é o que
 * precisa ser honesto — mockar o hook provaria só que a página renderiza o estado que eu montei.
 */

let falharScores = false;

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

const PEDIDOS = [{
  id: 'o1', customer_user_id: 'c1', items: [], total: 100,
  created_at: '2026-07-01T00:00:00Z', order_date_kpi: null, status: 'confirmado',
}];
const PERFIS = [{ user_id: 'c1', name: 'Cliente Um', phone: null }];
const FAIXAS = [{ customer_user_id: 'c1', faixa: 'verde', motivo: 'saudavel', g: 0.8, margem_pct: null }];
const CARTEIRA = [{ customer_user_id: 'c1' }];

function resposta(table: string): unknown {
  if (table === 'sales_orders') {
    if (falharScores) return { data: null, error: ERRO_TIMEOUT };
    return { data: PEDIDOS, error: null };
  }
  if (table === 'profiles') return { data: PERFIS, error: null };
  if (table === 'carteira_assignments') return { data: CARTEIRA, error: null };
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
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import FarmerLOCC from '../FarmerLOCC';

const renderLocc = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <FarmerLOCC />
    </QueryClientProvider>
  );
  return { qc, ...render(ui()) };
};

/** O bloco de números do "Motor de Diagnóstico" — o que NÃO pode aparecer sob falha sem dado. */
const blocoDiagnostico = () => screen.queryByText(/Health Score Médio/i);

beforeEach(() => {
  falharScores = false;
  vi.clearAllMocks();
});

describe('FarmerLOCC — falha de leitura não vira "Health Score 0"', () => {
  it('DETECTOR: o caminho feliz exibe o bloco de diagnóstico e não alerta nada', async () => {
    renderLocc();

    expect(await screen.findByText(/Motor de Diagnóstico/i)).toBeTruthy();
    // Sem este par, o `toBeNull()` do teste de erro passaria com um seletor morto.
    expect(blocoDiagnostico()).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sob falha SEM dado: alerta com motivo + retry, e nenhum número fabricado', async () => {
    falharScores = true;

    renderLocc();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'o alerta não diz que a leitura falhou').toMatch(/não foi possível|indispon/i);
    expect(
      blocoDiagnostico(),
      'exibiu "Health Score Médio" (0 fabricado) sobre uma carteira que NÃO foi lida',
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /Tentar novamente/i }),
      'sem retry o operador fica preso no estado de erro',
    ).toBeTruthy();
  });

  it('o retry recarrega de verdade: backend recuperado → diagnóstico aparece', async () => {
    falharScores = true;

    renderLocc();
    await screen.findByRole('alert');

    falharScores = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));

    expect(await screen.findByText(/Health Score Médio/i)).toBeTruthy();
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
  });

  it('mantém os números + aviso de desatualização quando o recálculo falha com dado na mão', async () => {
    // `useFarmerScoring` guarda em useState, então o último estado bom SOBREVIVE ao recálculo
    // que falhou — e aí a tela deve manter o número e avisar que é de antes, não zerar.
    renderLocc();
    await screen.findByText(/Health Score Médio/i);

    falharScores = true;
    fireEvent.click(screen.getByRole('button', { name: /Recalcular/i }));

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/desatualiz|última leitura/i);
    expect(
      blocoDiagnostico(),
      'descartou o último estado bom em vez de mantê-lo com aviso',
    ).toBeTruthy();
  });
});

describe('FarmerLOCC — o card de Recomendações não afirma contagem que ninguém calculou', () => {
  /**
   * Sítio da MESMA classe no `OverviewTab` (`useCrossSellEngine`, campo `erro` ignorado), com
   * um agravante que a leitura do código revelou: o `OverviewTab` tem a sua PRÓPRIA instância
   * do motor e **nunca chama `calculateRecommendations`** — o hook é `useState([])` puro, sem
   * efeito de montagem, e só a página `/farmer/recommendations` dispara o cálculo (na instância
   * DELA). Então a contagem exibida aqui não era "zero por falha de leitura": era **zero
   * constante desde a origem** (conferido em `git show` do pré-split #249, onde o mesmo
   * `useCrossSellEngine()` já era chamado sem disparo e o número saía formatado em R$).
   *
   * Ler o `erro` não consertaria nada — não há execução para falhar. O que mente é a
   * CONTAGEM: ausente ≠ zero (CLAUDE.md). O card segue levando para a tela das recomendações,
   * que calcula de verdade e já lê `erro`/`desatualizado`; o número fabricado sai.
   */
  it('DETECTOR: o matcher de dígito está VIVO neste DOM', async () => {
    renderLocc();

    // Sem este par, `not.toMatch(/\d/)` abaixo passaria num DOM sem número nenhum — ausência
    // por vacuidade (armadilha do seletor morto, #1585). Os KPIs têm números de verdade.
    await screen.findByText(/Motor de Diagnóstico/i);
    expect(screen.getByText('Cap./Dia').parentElement?.textContent).toMatch(/\d/);
  });

  it('o card existe, leva às recomendações e NÃO afirma um total', async () => {
    renderLocc();

    const card = await screen.findByTestId('card-recomendacoes');
    expect(card.textContent, 'o card perdeu o rótulo — o seletor casaria qualquer coisa').toMatch(
      /Recomenda/i,
    );
    expect(
      card.textContent,
      'afirmou um total de recomendações que NINGUÉM calculou (a instância do motor desta aba ' +
        'nunca dispara o cálculo — o número era zero constante)',
    ).not.toMatch(/\d/);
  });
});
