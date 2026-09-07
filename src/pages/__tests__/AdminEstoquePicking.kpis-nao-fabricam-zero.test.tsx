import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/**
 * Guard da classe IRMÃ da que some: `ausente → zero` (CLAUDE.md §Money-path).
 *
 * O painel de KPIs não usa a forma `{data && <X/>}` — ele faz `value: tasksAbertas ?? 0` e PINTA
 * o card. A leitura que falha deixa `data === undefined`, o `??` a converte em "0", e o separador
 * lê "0 Tasks Abertas" / "0 SKUs Críticos" / "0,0% FEFO" como afirmação sobre o chão de fábrica.
 * É pior que sumir: um número tem exatamente a mesma aparência quando é medido e quando é
 * fabricado, então nada na tela convida a desconfiar.
 *
 * ⚠️ DENOMINADOR (psql-ro, 2026-09-07) — as duas metades NÃO são iguais:
 *   `picking_tasks`/`picking_task_items`/`picking_events` = 0 linhas → dano ainda hipotético.
 *   `inventory_position` = 3.166 linhas (colacor_vendas 1.452 · vendas 837 · oben 828), com
 *   5/1/1 SKUs de saldo ≤ 0 → o card "SKUs Críticos" e a aba Estoque JÁ servem dado real, e a
 *   negativa de permissão da view operacional (`has_role`, medida no psql-ro) é o modo de falha
 *   ESPERADO ali. Para esses dois sítios o "0" não é risco futuro: é a mentira de hoje.
 *
 * O primeiro caso de cada bloco afirma o estado da QUERY, senão o guard aprovaria um fix inerte
 * (degradar o card não é alcançável enquanto o `queryFn` engolir o erro).
 *
 * As queries rodam de verdade; só o supabase é mockado, roteado por tabela.
 */

type Resposta = { data: unknown; error: { message: string } | null; count?: number | null };

let falharEm: string | null = null;
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

/**
 * O VALOR do card, lido pela estrutura (label e valor são irmãos no mesmo `<div>`) — não por
 * `getByText('0')`, que casaria com qualquer "0" da página e passaria verde pelo card errado.
 */
async function valorDoCard(label: string) {
  const el = await screen.findByText(label);
  return el.nextElementSibling?.textContent ?? '';
}

/**
 * Espera a query ASSENTAR antes de ler o card — e esta espera é a asserção, não cerimônia.
 *
 * MEDIDO no laço de falsificação (2026-09-07): durante o loading o card já exibe o valor
 * TRANSITÓRIO — `fefoCompliance?.pct == null` é true quando `data` ainda é `undefined`, então o
 * FEFO mostra "—" antes de qualquer leitura acontecer. Um `waitFor(() => expect(valor).toBe('—'))`
 * passava na PRIMEIRA tentativa, e o teste aprovava o spinner em vez da medição: sabotar
 * `pct: null → 0` ficava VERDE. O espelho vale para os counts, que mostram "0" no loading
 * (`undefined ?? 0`) — ali um teste de "ZERO real" passaria sem nunca ver o zero medido.
 */
async function assentar(
  qc: QueryClient,
  chave: readonly unknown[],
  status: 'success' | 'error',
) {
  await waitFor(() => expect(qc.getQueryState([...chave])?.status).toBe(status));
}

beforeEach(() => { falharEm = null; dados = {}; });
afterEach(() => { onlineManager.setOnline(true); vi.restoreAllMocks(); });

describe('KPIs — a leitura que falhou não vira o número "0"', () => {
  it('a query de tasks abertas entra em ERRO quando o count falha (hoje ela engole)', async () => {
    falharEm = 'picking_tasks';
    const { qc } = renderAba('picking');

    await waitFor(() => {
      expect(qc.getQueryState(['pk-tasks-abertas', 'OBEN'])?.status).toBe('error');
    });
  });

  it('ERRO: "Tasks Abertas" e "Pedidos Aguardando" mostram "—", nunca "0"', async () => {
    falharEm = 'picking_tasks';
    const { qc } = renderAba('picking');

    await assentar(qc, ['pk-tasks-abertas', 'OBEN'], 'error');
    await assentar(qc, ['pk-pedidos-aguardando', 'OBEN'], 'error');
    expect(await valorDoCard('Tasks Abertas')).toBe('—');
    expect(await valorDoCard('Pedidos Aguardando')).toBe('—');
  });

  it('ERRO: o bloco de KPIs FALA — não fica um painel de zeros calado', async () => {
    falharEm = 'picking_tasks';
    renderAba('picking');

    const aviso = await screen.findByTestId('aviso-picking-kpis');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
  });

  it('a query de SKUs críticos entra em ERRO quando a view operacional nega permissão', async () => {
    falharEm = 'inventory_position_operacional';
    const { qc } = renderAba('picking');

    await waitFor(() => {
      expect(qc.getQueryState(['pk-skus-criticos', 'OBEN'])?.status).toBe('error');
    });
  });

  it('ERRO na view: "SKUs Críticos" mostra "—" — o "0" aqui seria "estoque sadio"', async () => {
    falharEm = 'inventory_position_operacional';
    const { qc } = renderAba('picking');

    await assentar(qc, ['pk-skus-criticos', 'OBEN'], 'error');
    expect(await valorDoCard('SKUs Críticos')).toBe('—');
    expect(await screen.findByTestId('aviso-picking-kpis')).toBeTruthy();
  });

  it('ERRO no FEFO: mostra "—", não "0.0%" pintado de vermelho', async () => {
    falharEm = 'picking_tasks';
    const { qc } = renderAba('picking');

    await assentar(qc, ['pk-fefo-compliance', 'OBEN'], 'error');
    expect(await valorDoCard('FEFO Compliance')).toBe('—');
  });

  it('SEM denominador: FEFO é "—" — nenhum item separado não é 0% de conformidade', async () => {
    const { qc } = renderAba('picking');

    // Assentar em `success` é o que separa esta asserção do "—" do loading: aqui a leitura
    // ACONTECEU e devolveu 0 tasks, e é a AUSÊNCIA de denominador que precisa virar "—".
    await assentar(qc, ['pk-fefo-compliance', 'OBEN'], 'success');
    expect(await valorDoCard('FEFO Compliance')).toBe('—');
    expect(screen.queryByTestId('aviso-picking-kpis')).toBeNull();
  });

  it('ZERO real: os counts mostram "0" mesmo, e sem aviso', async () => {
    const { qc } = renderAba('picking');

    await assentar(qc, ['pk-tasks-abertas', 'OBEN'], 'success');
    await assentar(qc, ['pk-pedidos-aguardando', 'OBEN'], 'success');
    await assentar(qc, ['pk-skus-criticos', 'OBEN'], 'success');
    expect(await valorDoCard('Tasks Abertas')).toBe('0');
    expect(await valorDoCard('Pedidos Aguardando')).toBe('0');
    expect(await valorDoCard('SKUs Críticos')).toBe('0');
    expect(screen.queryByTestId('aviso-picking-kpis')).toBeNull();
  });

  it('OFFLINE: cards mudos e aviso de rede — não um painel de zeros', async () => {
    onlineManager.setOnline(false);
    renderAba('picking');

    const aviso = await screen.findByTestId('aviso-picking-kpis');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
    expect(await valorDoCard('Tasks Abertas')).toBe('—');
  });
});

describe('Itens da task expandida — "Sem itens." e o spinner eterno', () => {
  const UMA_TASK = [{ id: 'task-aaa-1111', sales_order_id: 'so-1', status: 'pendente', assigned_to: null, created_at: '2026-09-01T10:00:00Z' }];

  async function expandir() {
    const linha = (await screen.findByText('task-aaa')).closest('tr');
    fireEvent.click(linha!.querySelector('button')!);
  }

  it('a query dos itens entra em ERRO quando o select falha', async () => {
    dados = { picking_tasks: UMA_TASK };
    falharEm = 'picking_task_items';
    const { qc } = renderAba('picking');
    await expandir();

    await waitFor(() => {
      expect(qc.getQueryState(['pk-picking-items', 'task-aaa-1111'])?.status).toBe('error');
    });
  });

  it('ERRO: não diz "Sem itens." nem trava em "Carregando itens..."', async () => {
    dados = { picking_tasks: UMA_TASK };
    falharEm = 'picking_task_items';
    const { container } = renderAba('picking');
    await expandir();

    expect(await screen.findByTestId('aviso-picking-itens')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Sem itens/i);
    expect(container.textContent).not.toMatch(/Carregando itens/i);
  });

  it('ZERO real: aí sim "Sem itens.", e sem aviso', async () => {
    dados = { picking_tasks: UMA_TASK, picking_task_items: [] };
    renderAba('picking');
    await expandir();

    expect(await screen.findByText(/Sem itens/i)).toBeTruthy();
    expect(screen.queryByTestId('aviso-picking-itens')).toBeNull();
  });
});

describe('Aba Estoque — fonte VIVA (3.166 linhas em prod)', () => {
  it('a query de inventário entra em ERRO quando a view nega permissão', async () => {
    falharEm = 'inventory_position_operacional';
    const { qc } = renderAba('estoque');

    await waitFor(() => {
      expect(qc.getQueryState(['pk-inventory', 'OBEN'])?.status).toBe('error');
    });
  });

  it('ERRO: não diz "Nenhum SKU encontrado." — diz que não conseguiu ler', async () => {
    falharEm = 'inventory_position_operacional';
    const { container } = renderAba('estoque');

    expect(await screen.findByTestId('aviso-picking-inventario')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Nenhum SKU encontrado/i);
  });

  it('ZERO real: aí sim "Nenhum SKU encontrado.", e sem aviso', async () => {
    const { container } = renderAba('estoque');

    expect(await screen.findByText(/Nenhum SKU encontrado/i)).toBeTruthy();
    expect(screen.queryByTestId('aviso-picking-inventario')).toBeNull();
    expect(container.textContent).toBeTruthy();
  });

  it('OFFLINE: não afirma estoque vazio — diz que falta rede', async () => {
    onlineManager.setOnline(false);
    const { container } = renderAba('estoque');

    const aviso = await screen.findByTestId('aviso-picking-inventario');
    expect(aviso.getAttribute('data-estado')).toBe('sem-rede');
    expect(container.textContent).not.toMatch(/Nenhum SKU encontrado/i);
  });
});
