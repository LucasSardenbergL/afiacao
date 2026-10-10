import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — a falha do scoring tem de CHEGAR ao roteirizador.
 *
 * Classe #1565→#1579→#1697→#2894→#2905→#2907, e aqui ela atravessava DOIS arquivos: o
 * `useRoutePlanner` destruturava `{ agenda, clientScores, loading }` de `useFarmerScoring` e
 * jogava o `erro` no chão; a página, que não tinha o que ler, afirmava a rota.
 *
 * O dano é de ESCOPO, não de total: `loadCommercialStops` monta as paradas comerciais a partir
 * do `agenda`, então sob falha a dimensão CARTEIRA desaparece inteira — e o que sobra (as
 * ferramentas vencidas) é apresentado como "Rota de hoje", com contagem de paradas e tudo. Sem
 * nenhuma parada, a tela instruía: "Nenhuma visita comercial disponível. Configure datas de
 * afiação nas ferramentas dos clientes" — uma TAREFA inventada por uma falha de leitura. O
 * vendedor sai para a rua com um roteiro que parece completo.
 *
 * É a mesma lição do corte por ranking (`docs/historico/roteirizador-corte-cidades.md`): um
 * roteiro a menos não é um roteiro menor, é outro roteiro.
 *
 * Contrato (§7 do money-path.md): sem cache → "indisponível" com o motivo + retry. Nunca uma
 * rota silenciosamente parcial.
 *
 * Os hooks rodam de VERDADE (só o supabase e o leaflet são dublês): a cadeia
 * leitura→scoring→paradas é o que precisa ser honesta.
 */

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

let falharScoring = false;
let carteiraVazia = false;

const PEDIDOS = [{
  id: 'o1', customer_user_id: 'c1', items: [], total: 100,
  created_at: '2026-07-01T00:00:00Z', order_date_kpi: null, status: 'confirmado',
}];
const PERFIS = [{ user_id: 'c1', name: 'Marcenaria Alfa', phone: null, business_hours_open: null, business_hours_close: null }];
const FAIXAS = [{ customer_user_id: 'c1', faixa: 'verde', motivo: 'saudavel', g: 0.8, margem_pct: null }];
const CARTEIRA = [{ customer_user_id: 'c1' }];

function resposta(table: string): unknown {
  if (table === 'sales_orders') {
    if (falharScoring) return { data: null, error: ERRO_TIMEOUT };
    return { data: carteiraVazia ? [] : PEDIDOS, error: null };
  }
  if (table === 'profiles') return { data: carteiraVazia ? [] : PERFIS, error: null };
  if (table === 'carteira_assignments') return { data: carteiraVazia ? [] : CARTEIRA, error: null };
  return { data: [], error: null, count: 0 };
}

function respostaRpc(fn: string): unknown {
  if (fn === 'get_carteira_margem_faixa') {
    if (falharScoring) return { data: null, error: ERRO_TIMEOUT };
    return { data: carteiraVazia ? [] : FAIXAS, error: null };
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
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
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

// Leaflet não roda em jsdom (precisa de layout real). O dublê é de BORDA: o mapa não é o que
// este guard mede — o que se mede é o que a tela AFIRMA sobre a rota.
vi.mock('leaflet', () => {
  const camada = () => {
    const c: Record<string, unknown> = {};
    c.addTo = () => c;
    c.remove = () => undefined;
    c.addLayer = () => c;
    c.clearLayers = () => c;
    c.bindPopup = () => c;
    c.on = () => c;
    c.setView = () => c;
    c.fitBounds = () => c;
    c.getChildCount = () => 0;
    c.getAllChildMarkers = () => [];
    return c;
  };
  const L = {
    map: () => camada(),
    tileLayer: () => camada(),
    layerGroup: () => camada(),
    markerClusterGroup: () => camada(),
    marker: () => camada(),
    polyline: () => camada(),
    divIcon: () => ({}),
    latLngBounds: () => ({ isValid: () => false, pad: () => ({}) }),
    Icon: { Default: { mergeOptions: () => undefined, prototype: {} } },
  };
  return { default: L, ...L };
});
vi.mock('leaflet.markercluster', () => ({}));

vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'farmer-a' };
  return { useAuth: () => ({ user, isStaff: true, isMaster: false, loading: false }) };
});
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: 'farmer-a' }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }) }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));

import AdminRoutePlanner from '../AdminRoutePlanner';

const montar = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <AdminRoutePlanner />
      </QueryClientProvider>,
    ),
  };
};

/** O empty state de SUCESSO do roteiro (modo híbrido, o default). */
const rotaVazia = () => screen.queryByText(/Nenhuma parada encontrada/i);

beforeEach(() => {
  falharScoring = false;
  carteiraVazia = false;
  vi.clearAllMocks();
});

describe('AdminRoutePlanner — rota parcial por falha de leitura é declarada', () => {
  it('DETECTOR: carteira legitimamente VAZIA (leitura OK) mostra o empty state e não avisa', async () => {
    // Par que mantém o seletor VIVO e separa "não há" de "não consegui": sem ele o
    // `rotaVazia() === null` do caso de erro passaria com seletor morto (#1585), e um fix que
    // nunca mostrasse o empty state também passaria.
    carteiraVazia = true;

    montar();

    expect(await screen.findByText(/Nenhuma parada encontrada/i)).toBeTruthy();
    expect(screen.queryByTestId('aviso-carteira-rota')).toBeNull();
  });

  it('sob falha: aviso com motivo e retry, e NENHUMA tarefa inventada', async () => {
    falharScoring = true;

    montar();

    const aviso = await screen.findByTestId('aviso-carteira-rota');
    expect(aviso.textContent, 'o aviso não diz que a leitura falhou').toMatch(
      /não foi possível|não consegui|indispon/i,
    );
    expect(
      rotaVazia(),
      'afirmou "nenhuma parada encontrada" sobre uma carteira que NÃO foi lida',
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /Tentar novamente/i }),
      'sem retry o vendedor fica preso no estado de erro',
    ).toBeTruthy();
  });

  it('o retry recarrega de verdade: backend recuperado → o aviso sai', async () => {
    falharScoring = true;

    montar();
    await screen.findByTestId('aviso-carteira-rota');

    falharScoring = false;
    carteiraVazia = true;
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));

    await waitFor(() => { expect(screen.queryByTestId('aviso-carteira-rota')).toBeNull(); });
    expect(rotaVazia()).toBeTruthy();
  });
});
