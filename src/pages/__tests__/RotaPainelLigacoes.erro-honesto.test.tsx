import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard — erro do painel da rota não pode virar SKELETON ETERNO.
 *
 * A página gateava `if (isLoading || !p) return <PageSkeleton/>`: com o `useRoutePanel` em
 * erro, `p` fica undefined para sempre e a tela shimmerava eternamente — o anti-padrão
 * explícito do §7 do money-path.md ("sem cache → 'indisponível' com motivo", nunca skeleton
 * sem fim). O gestor não tem como saber se está lento ou quebrado.
 *
 * Contrato: falha sem dado → estado de erro com retry; falha com dado em cache → manter o
 * painel e avisar que pode estar desatualizado.
 *
 * O hook roda de VERDADE (só o supabase é mockado): a cadeia leitura→agregação→tela é o que
 * precisa ser honesto.
 */

let falharPainel = false;
/** Leitura em VOO (promessa nunca resolve) — para o DETECTOR provar que o seletor de skeleton enxerga um skeleton vivo. */
let painelPendente = false;

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

// 1 elegível na janela (hoje é 2026-07-23; a janela default de 30 dias cobre 2026-07-20).
const SNAPSHOT = [{
  data_rota: '2026-07-20', farmer_id: 'f1', customer_user_id: 'c1',
  cliente_nome: 'Cliente Um', cidade: 'SP', bucket: 'top', valor_da_ligacao: 1000, rank: 1,
}];

function resposta(table: string): unknown {
  if (table === 'route_queue_snapshot' || table === 'route_contact_log') {
    if (falharPainel) return { data: null, error: ERRO_TIMEOUT };
    if (table === 'route_queue_snapshot') return { data: SNAPSHOT, error: null };
  }
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => {
    if (painelPendente && (table === 'route_queue_snapshot' || table === 'route_contact_log')) {
      return undefined; // em voo: nem resolve nem rejeita
    }
    return resolve(resposta(table));
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isMaster: true, isGestorComercial: false }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import RotaPainelLigacoes from '../RotaPainelLigacoes';

const renderPagina = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <RotaPainelLigacoes />
    </QueryClientProvider>
  );
  return { qc, ...render(ui()) };
};

/** O <Skeleton> do projeto usa shimmer gradient (`animate-shimmer`), não o pulse do shadcn. */
const skeletons = (c: HTMLElement) => c.querySelectorAll('[class*="animate-shimmer"]');

beforeEach(() => {
  falharPainel = false;
  painelPendente = false;
  vi.clearAllMocks();
});

describe('RotaPainelLigacoes — erro não vira skeleton eterno', () => {
  it('DETECTOR: o caminho feliz renderiza os KPIs, sem alerta e sem skeleton', async () => {
    const { container } = renderPagina();

    expect(await screen.findByText('Cobertura da fila')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(skeletons(container).length).toBe(0);
  });

  it('DETECTOR: leitura em voo mostra skeleton (o seletor enxerga um skeleton vivo)', async () => {
    // Sem este par, o assert "0 skeletons sob erro" passaria com um seletor quebrado.
    painelPendente = true;

    const { container } = renderPagina();

    await waitFor(() => { expect(skeletons(container).length).toBeGreaterThan(0); });
  });

  it('sob falha sem dado: alerta com motivo + retry, e NENHUM skeleton', async () => {
    falharPainel = true;

    const { container } = renderPagina();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'o alerta não diz que a leitura falhou').toMatch(/não foi possível|indispon/i);
    expect(
      screen.getByRole('button', { name: /Tentar novamente/i }),
      'sem retry o gestor fica preso no estado de erro',
    ).toBeTruthy();
    await waitFor(() => {
      expect(skeletons(container).length, 'skeleton eterno: a falha não resolveu o carregamento').toBe(0);
    });
  });

  it('o retry recarrega de verdade: backend recuperado → painel aparece', async () => {
    falharPainel = true;

    renderPagina();
    await screen.findByRole('alert');

    falharPainel = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));

    expect(await screen.findByText('Cobertura da fila')).toBeTruthy();
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
  });

  it('mantém o painel + aviso de desatualização quando o refetch falha com dado na mão', async () => {
    const { qc } = renderPagina();
    await screen.findByText('Cobertura da fila');

    falharPainel = true;
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['route-panel'] });
    });

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'nada avisa que os números são de antes').toMatch(/última leitura|desatualizad/i);
    expect(screen.getByText('Cobertura da fila'), 'descartou o último estado bom').toBeTruthy();
  });
});
