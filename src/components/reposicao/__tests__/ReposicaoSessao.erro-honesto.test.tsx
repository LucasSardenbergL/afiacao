import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — a falha de leitura do ciclo tem de CHEGAR às três superfícies da sessão
 * de Reposição (stepper do layout, grid de etapas, checklist da etapa).
 *
 * Buraco (classe #1565→#1579→#1697→#2894, consumidores que ficaram de fora): os três
 * destruturavam `{ data, isLoading }` de `useReposicaoStatus` e ignoravam o `isError` que o
 * hook JÁ expõe. Sob falha dos pedidos do ciclo `data === undefined` e `isLoading === false`,
 * e daí cada um mentia de um jeito diferente:
 *
 * - `ReposicaoSessionLayout`: `status?.current ?? 3` FABRICA a etapa — a tela afirma "etapa
 *   atual 3. Pedidos" sobre um ciclo que não foi lido. Para quem opera, "estou na etapa de
 *   revisar pedidos" e "não consegui ler o ciclo" pedem ações opostas.
 * - `EtapasGrid` e `EtapaChecklist`: o guard era `isLoading || !status`, então com `isLoading`
 *   já falso e `status` undefined o componente ficava em SKELETON ETERNO — cara de "está
 *   carregando" para sempre, sem nunca dizer que a leitura falhou nem oferecer retry.
 *
 * Contrato (§7 do money-path.md): falha → retry → último dado bom + aviso de stale; sem cache
 * → "indisponível" com o motivo. Nunca etapa fabricada, nunca skeleton eterno.
 *
 * O hook roda de VERDADE (só o supabase é mockado): a cadeia leitura→derivação de etapa→tela é
 * o que precisa ser honesto — mockar o hook provaria só que a tela renderiza o que eu montei.
 */

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

let falharPedidos = false;
let travarPedidos = false;

/** 2 pendentes ⇒ deriveCurrentStep devolve 3 (Pedidos) pelos DADOS, não por default. */
const PEDIDOS = [{ status: 'pendente_aprovacao' }, { status: 'pendente_aprovacao' }];

function resposta(table: string): unknown {
  if (table === 'pedido_compra_sugerido') {
    if (falharPedidos) return { data: null, error: ERRO_TIMEOUT };
    return { data: PEDIDOS, error: null };
  }
  if (table === 'v_oportunidade_economica_hoje_badge_cached') {
    return { data: { oportunidade_count: 0 }, error: null };
  }
  return { data: [], error: null, count: 0 };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains', 'returns',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => {
    if (table === 'pedido_compra_sugerido' && travarPedidos) return new Promise(() => {});
    return resolve(resposta(table));
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => chain(t) },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import ReposicaoSessionLayout from '../ReposicaoSessionLayout';
import { EtapasGrid } from '../EtapasGrid';
import { EtapaChecklist } from '../EtapaChecklist';

const montar = (ui: ReactElement, rota = '/admin/reposicao/sessao/pedidos') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[rota]}>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
  return { qc, ...render(arvore()) };
};

/** O shimmer do `<Skeleton>` — é ele que ficava eterno. */
const skeletons = () => document.querySelectorAll('.animate-shimmer');

beforeEach(() => {
  falharPedidos = false;
  travarPedidos = false;
  vi.clearAllMocks();
});

describe('ReposicaoSessionLayout — a etapa vem dos dados, nunca do default 3', () => {
  it('DETECTOR: o caminho feliz afirma a etapa derivada e não alerta nada', async () => {
    montar(<ReposicaoSessionLayout />, '/admin/reposicao/sessao');

    // `/admin/reposicao/sessao` é o index: o stepper destaca o PROGRESSO (dados).
    expect(await screen.findByText(/3\. Pedidos/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sob falha: nenhuma etapa afirmada, alerta com motivo e retry', async () => {
    falharPedidos = true;

    montar(<ReposicaoSessionLayout />, '/admin/reposicao/sessao');

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent, 'o alerta não diz que a leitura do ciclo falhou').toMatch(
      /não foi possível|não consegui|indispon/i,
    );
    expect(
      screen.queryByText(/3\. Pedidos/),
      'afirmou "etapa atual 3. Pedidos" sobre um ciclo que NÃO foi lido',
    ).toBeNull();
    expect(
      screen.queryByText(/etapa atual/i),
      'afirmou ter uma "etapa atual" sem ter lido o ciclo',
    ).toBeNull();
    expect(screen.getByRole('button', { name: /Tentar novamente/i })).toBeTruthy();
  });

  it('o retry recarrega de verdade: backend recuperado → etapa aparece', async () => {
    falharPedidos = true;

    montar(<ReposicaoSessionLayout />, '/admin/reposicao/sessao');
    await screen.findByRole('alert');

    falharPedidos = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));

    expect(await screen.findByText(/3\. Pedidos/)).toBeTruthy();
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
  });

  it('último dado bom + aviso de stale quando a releitura falha', async () => {
    const { qc } = montar(<ReposicaoSessionLayout />, '/admin/reposicao/sessao');
    await screen.findByText(/3\. Pedidos/);

    falharPedidos = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ['cockpit-pedidos'] }); });

    expect(
      screen.getByText(/3\. Pedidos/),
      'descartou o último dado bom em vez de mantê-lo com aviso',
    ).toBeTruthy();
    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/desatualizad|stale|última leitura/i);
  });
});

describe('EtapasGrid — sem skeleton eterno', () => {
  it('DETECTOR: o seletor de skeleton enxerga um shimmer VIVO enquanto carrega', () => {
    // Sem este par, `skeletons().length === 0` no teste de erro passaria com um seletor morto
    // (armadilha do #1585).
    travarPedidos = true;

    montar(<EtapasGrid />);

    expect(skeletons().length).toBeGreaterThan(0);
  });

  it('DETECTOR: o caminho feliz descreve as etapas e sai do skeleton', async () => {
    montar(<EtapasGrid />);

    expect(await screen.findByText(/^2 pedido\(s\) aguardando revisão$/)).toBeTruthy();
    expect(skeletons().length).toBe(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sob falha: alerta com motivo em vez de skeleton eterno', async () => {
    falharPedidos = true;

    montar(<EtapasGrid />);

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/não foi possível|não consegui|indispon/i);
    expect(
      skeletons().length,
      'ficou em skeleton eterno: a tela finge carregar para sempre',
    ).toBe(0);
    expect(screen.getByRole('button', { name: /Tentar novamente/i })).toBeTruthy();
  });

  it('último dado bom + aviso de stale quando a releitura falha', async () => {
    const { qc } = montar(<EtapasGrid />);
    await screen.findByText(/^2 pedido\(s\) aguardando revisão$/);

    falharPedidos = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ['cockpit-pedidos'] }); });

    expect(screen.getByText(/^2 pedido\(s\) aguardando revisão$/)).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toMatch(/desatualizad|última leitura/i);
  });
});

describe('EtapaChecklist — sem skeleton eterno', () => {
  it('DETECTOR: o seletor de skeleton enxerga um shimmer VIVO enquanto carrega', () => {
    travarPedidos = true;

    montar(<EtapaChecklist step={3} />);

    expect(skeletons().length).toBeGreaterThan(0);
  });

  it('DETECTOR: o caminho feliz monta o checklist da etapa', async () => {
    montar(<EtapaChecklist step={3} />);

    expect(await screen.findByText(/Para concluir a Etapa 3: Pedidos/)).toBeTruthy();
    expect(skeletons().length).toBe(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sob falha: alerta com motivo em vez de skeleton eterno', async () => {
    falharPedidos = true;

    montar(<EtapaChecklist step={3} />);

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/não foi possível|não consegui|indispon/i);
    expect(skeletons().length, 'ficou em skeleton eterno').toBe(0);
    expect(
      screen.queryByText(/Revisar 0 pedido\(s\) pendente\(s\)|Gerar pedidos do ciclo de hoje/),
      'fabricou item de checklist sobre um ciclo que não foi lido',
    ).toBeNull();
  });

  it('último dado bom + aviso de stale quando a releitura falha', async () => {
    const { qc } = montar(<EtapaChecklist step={3} />);
    await screen.findByText(/Para concluir a Etapa 3: Pedidos/);

    falharPedidos = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ['cockpit-pedidos'] }); });

    expect(screen.getByText(/Para concluir a Etapa 3: Pedidos/)).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toMatch(/desatualizad|última leitura/i);
  });
});
