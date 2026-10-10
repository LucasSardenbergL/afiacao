import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard money-path — o cockpit de reposição não pode AFIRMAR em que etapa o comprador está
 * quando não leu o ciclo.
 *
 * Irmão dos sítios do `useReposicaoStatus` (layout/grid/checklist) e **invisível ao detector**
 * `src/lib/gates/sinal-de-falha-ignorado.ts`: o consumo passava pelo wrapper `useCurrentStep`,
 * cujo `return { ...q, data: q.data?.current ?? DEFAULT.current }` é um SPREAD — o
 * `mapearHooksComSinal` só reconhece campo de sinal em propriedade NOMEADA, então o wrapper
 * nunca entrou no mapa de hooks e o consumidor não contava como sítio. Cegueira do lado do
 * PRODUTOR, não do consumidor.
 *
 * O dano era duplo e composto: o wrapper já devolvia 3 por default E a página repetia
 * `= 3` na destruturação. Sob falha de leitura o `ContinuarBanner` dizia "Você está na etapa
 * 3: Pedidos" e o botão "Continuar" levava o comprador para revisar pedidos de um ciclo que
 * NUNCA foi lido. Pior: desde a correção do layout, a mesma viewport mostrava "não consegui
 * ler o ciclo" (no stepper) e "você está na etapa 3" (no banner) — telas se contradizendo.
 *
 * Contrato (§7 do money-path.md): sem cache → "indisponível" com o motivo + retry. Nunca
 * etapa fabricada. O wrapper foi APOSENTADO: a página consome `useReposicaoStatus` direto,
 * e com isso o gate passa a VER este consumidor e a exigir o `isError`.
 */

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

let falharPedidos = false;

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
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}

const canal = () => {
  const ch: Record<string, unknown> = {};
  ch.on = () => ch;
  ch.subscribe = () => ch;
  return ch;
};

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    // `get_data_health` responde OK de propósito: o DataHealthBanner tem aviso PRÓPRIO em
    // falha, e deixá-lo falhar poluiria a asserção deste guard com o aviso dele.
    rpc: () => Promise.resolve({ data: [], error: null }),
    channel: () => canal(),
    removeChannel: () => undefined,
    functions: { invoke: () => Promise.resolve({ error: null }) },
  },
}));
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'comprador-1' };
  return { useAuth: () => ({ user, isStaff: true, isMaster: false, loading: false }) };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import AdminReposicaoCockpit from '../AdminReposicaoCockpit';

const montar = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/reposicao/sessao']}>
        <AdminReposicaoCockpit />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { qc, ...render(arvore()) };
};

beforeEach(() => {
  falharPedidos = false;
  vi.clearAllMocks();
});

describe('AdminReposicaoCockpit — "você está na etapa X" só com o ciclo lido', () => {
  it('DETECTOR: o caminho feliz afirma a etapa derivada dos dados', async () => {
    montar();

    // 2 pendentes ⇒ deriveCurrentStep = 3 (Pedidos), pelos DADOS.
    expect((await screen.findAllByText(/etapa 3/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Continuar|Começar/ })).toBeTruthy();
  });

  it('sob falha: nenhuma etapa afirmada, aviso com motivo e retry', async () => {
    falharPedidos = true;

    montar();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toMatch(/não foi possível|não consegui|indispon/i);
    expect(
      screen.queryAllByText(/etapa 3/),
      'disse "você está na etapa 3" sobre um ciclo que NÃO foi lido',
    ).toHaveLength(0);
    expect(
      screen.queryByRole('button', { name: /^Continuar$/ }),
      'ofereceu "Continuar" para uma etapa que não existe',
    ).toBeNull();
    expect(screen.getByRole('button', { name: /Tentar novamente/i })).toBeTruthy();
  });

  it('o retry recarrega de verdade: backend recuperado → etapa aparece', async () => {
    falharPedidos = true;

    montar();
    await screen.findByRole('alert');

    falharPedidos = false;
    fireEvent.click(screen.getByRole('button', { name: /Tentar novamente/i }));

    expect((await screen.findAllByText(/etapa 3/)).length).toBeGreaterThan(0);
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull(); });
  });

  it('último dado bom: o banner mantém a etapa, mas RESSALVA no ponto da afirmação', async () => {
    const { qc } = montar();
    await screen.findAllByText(/etapa 3/);

    falharPedidos = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ['cockpit-pedidos'] }); });

    expect(
      screen.getAllByText(/etapa 3/).length,
      'descartou o último dado bom em vez de mantê-lo ressalvado',
    ).toBeGreaterThan(0);
    // Âncora PRÓPRIA do banner: casar a frase passava verde pelo aviso do `EtapasGrid` logo
    // abaixo, que diz quase a mesma coisa — a sabotagem que removia a ressalva do banner não
    // reprovava (pego na falsificação; é a lição do `testId` do AvisoLeituraFalhou).
    expect(
      await screen.findByTestId('continuar-banner-stale'),
      'manteve a afirmação "você está na etapa 3" sem ressalvar que a releitura falhou',
    ).toBeTruthy();
  });
});
