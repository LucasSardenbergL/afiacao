import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Guard da FATIA DE GATILHO — `picking_tasks` tem 0 linhas em prod (psql-ro, 2026-09-06).
 * Três frases afirmativas pendem dessa fonte, e as três são o sub-tipo que MENTE:
 * "Nenhuma task de picking.", "Sem movimentações.", "Nenhuma task concluída."
 * (docs/historico/a-forma-que-some-e-a-forma-que-mente.md).
 *
 * ⚠️ Os três `queryFn` **engolem o erro** (`const { data } = await supabase…; return data ?? []`):
 * a query fica `success` com `[]`, e a frase é dita com a mesma convicção do vazio real. A
 * correção começa no `queryFn` — por isso o primeiro caso de cada aba afirma o estado da QUERY,
 * senão o guard aprovaria um fix inerte.
 *
 * As queries rodam de verdade; só o supabase é mockado, roteado por tabela.
 */

type Resposta = { data: unknown; error: { message: string } | null; count?: number | null };

let falharEm: string | null = null;
/** Linhas por tabela — permite a 1ª leitura VIR e só a 2ª falhar. Um mock que só sabe
 *  "tudo ok" ou "tudo erro" não alcança a 2ª leitura de um queryFn encadeado. */
let dados: Record<string, unknown[]> = {};
const ERRO: Resposta = { data: null, error: { message: 'permission denied' }, count: null };
const ok = (t: string): Resposta => {
  const linhas = dados[t] ?? [];
  return { data: linhas, error: null, count: linhas.length };
};

function builder(resposta: () => Resposta) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'limit', 'eq', 'in', 'not', 'lte', 'gte', 'ilike']) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown) => Promise.resolve(resposta()).then(ok);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: (t: string) => builder(() => (t === falharEm ? ERRO : ok(t))) },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/hooks/useIsTouchDevice', () => ({ useIsTouchDevice: () => false }));
vi.mock('@/components/picking/ScanBar', () => ({ ScanBar: () => null }));
vi.mock('@/queries/usePedidosASeparar', () => ({ usePedidosASeparar: () => ({ data: [], isLoading: false }) }));
vi.mock('@/queries/useEnviarParaSeparacao', () => ({
  useEnviarParaSeparacao: () => ({ mutate: vi.fn(), isPending: false }),
}));

import AdminEstoquePicking from '../AdminEstoquePicking';

function renderAba(aba: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/admin/estoque/picking?tab=${aba}`]}>
          <AdminEstoquePicking />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => { falharEm = null; dados = {}; });
afterEach(() => { onlineManager.setOnline(true); vi.restoreAllMocks(); });

describe('Picking (aba "picking") — "Nenhuma task de picking." é afirmação, não default', () => {
  it('a query da lista entra em ERRO quando o select falha (hoje ela engole)', async () => {
    falharEm = 'picking_tasks';
    const { qc } = renderAba('picking');

    await waitFor(() => {
      const estado = qc.getQueryState(['pk-picking-list', 'OBEN']);
      expect(estado?.status).toBe('error');
    });
  });

  it('ERRO: não diz "Nenhuma task de picking." — diz que não conseguiu ler', async () => {
    falharEm = 'picking_tasks';
    const { container } = renderAba('picking');

    expect(await screen.findByTestId('aviso-picking-lista')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Nenhuma task de picking/i);
  });

  it('ZERO real: aí sim a frase é verdadeira, e sem aviso', async () => {
    const { container } = renderAba('picking');

    expect(await screen.findByText(/Nenhuma task de picking/i)).toBeTruthy();
    expect(screen.queryByTestId('aviso-picking-lista')).toBeNull();
    expect(container.textContent).toBeTruthy();
  });

  it('OFFLINE: não afirma vazio — diz que falta rede', async () => {
    onlineManager.setOnline(false);
    const { container } = renderAba('picking');

    const aviso = await screen.findByTestId('aviso-picking-lista');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
    expect(container.textContent).not.toMatch(/Nenhuma task de picking/i);
  });
});

describe('Picking (aba "movimentacoes") — "Sem movimentações." é afirmação sobre auditoria', () => {
  it('a query de eventos entra em ERRO quando o select falha', async () => {
    falharEm = 'picking_events';
    const { qc } = renderAba('movimentacoes');

    await waitFor(() => expect(qc.getQueryState(['pk-events'])?.status).toBe('error'));
  });

  it('ERRO: não diz "Sem movimentações."', async () => {
    falharEm = 'picking_events';
    const { container } = renderAba('movimentacoes');

    expect(await screen.findByTestId('aviso-picking-eventos')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Sem movimentações/i);
  });

  it('ZERO real: a frase é dita, sem aviso', async () => {
    renderAba('movimentacoes');

    expect(await screen.findByText(/Sem movimentações/i)).toBeTruthy();
    expect(screen.queryByTestId('aviso-picking-eventos')).toBeNull();
  });
});

describe('Picking (aba "auditoria") — "Nenhuma task concluída." é afirmação sobre conferência', () => {
  it('a query de auditoria entra em ERRO quando o select falha', async () => {
    falharEm = 'picking_tasks';
    const { qc } = renderAba('auditoria');

    await waitFor(() => expect(qc.getQueryState(['pk-auditoria', 'OBEN'])?.status).toBe('error'));
  });

  it('ERRO: não diz "Nenhuma task concluída."', async () => {
    falharEm = 'picking_tasks';
    const { container } = renderAba('auditoria');

    expect(await screen.findByTestId('aviso-picking-auditoria')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Nenhuma task concluída/i);
  });

  it('ZERO real: a frase é dita, sem aviso', async () => {
    renderAba('auditoria');

    expect(await screen.findByText(/Nenhuma task concluída/i)).toBeTruthy();
    expect(screen.queryByTestId('aviso-picking-auditoria')).toBeNull();
  });

  /**
   * A SEGUNDA leitura da aba. As tasks vêm; só os ITENS falham. Sem `throw` na 2ª,
   * `divCount` fica vazio e cada linha recebe `divergencias: 0` — a coluna pinta um
   * badge VERDE de "0" sobre uma conferência que ninguém conseguiu ler. É o mesmo dano
   * da aba inteira, reduzido a um número.
   *
   * Este caso existe porque o laço de falsificação mostrou a camada VERDE sob sabotagem:
   * um queryFn com N leituras precisa de N sabotagens, e sem um mock que devolva sucesso
   * numa tabela e erro na outra a 2ª leitura é INALCANÇÁVEL pelo teste.
   */
  it('ERRO só nos ITENS: não pinta 0 divergência sobre o que ninguém leu', async () => {
    dados = {
      picking_tasks: [
        { id: 't1', sales_order_id: 'so1', completed_at: '2026-09-01T00:00:00Z', notes: null },
      ],
    };
    falharEm = 'picking_task_items';
    const { qc, container } = renderAba('auditoria');

    await waitFor(() => expect(qc.getQueryState(['pk-auditoria', 'OBEN'])?.status).toBe('error'));
    expect(await screen.findByTestId('aviso-picking-auditoria')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Nenhuma task concluída/i);
  });
});
