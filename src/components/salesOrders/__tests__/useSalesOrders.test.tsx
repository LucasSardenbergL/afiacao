// useSalesOrders: a listagem pagina e busca NO SERVIDOR (plano v4, lote 8 — C3).
// O supabase é um fake em memória com 6.000 pedidos — mais que os 5.000 que a tela antiga drenava —
// e uma coluna `busca` montada como a view a monta (migration 20261101221452): é o que prova que o
// termo que o hook manda casa com o formato da coluna, e que a busca alcança pedido fora do recorte.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Linha = {
  origin: string; id: string; created_at: string; account: string; order_number: string | null;
  omie_pedido_id: number | null; customer_user_id: string; customer_name: string | null;
  item_names: string[]; item_quantity: number; status: string; subtotal: number; total: number; busca: string;
};
type Pedido = { tabela: string; select?: string; count?: string; filtros: [string, string, string][]; range?: [number, number]; update?: unknown; in?: [string, string[]] };

const fake = vi.hoisted(() => ({ linhas: [] as Linha[], pedidos: [] as Pedido[] }));

// O mesmo que a view faz em SQL: entidades HTML do nome, '\n' entre campos, total nos 2 formatos,
// minúsculas e sem acento.
function buscaComoAView(l: Omit<Linha, 'busca'>): string {
  const nome = (l.customer_name ?? '').replace(/&amp;/g, '&').replace(/&apos;/g, "'");
  const total = l.total.toFixed(2);
  return [nome, l.order_number ?? '', l.item_names.join(' '), total, total.replace('.', ',')]
    .join('\n').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

vi.mock('@/integrations/supabase/client', () => {
  const builder = (tabela: string) => {
    const p: Pedido = { tabela, filtros: [] };
    fake.pedidos.push(p);
    const b = {
      select(cols: string, opts?: { count?: string }) { p.select = cols; p.count = opts?.count; return b; },
      eq(col: string, v: string) { p.filtros.push(['eq', col, v]); return b; },
      ilike(col: string, v: string) { p.filtros.push(['ilike', col, v]); return b; },
      order() { return b; },
      range(a: number, z: number) { p.range = [a, z]; return b; },
      update(v: unknown) { p.update = v; return b; },
      in(col: string, ids: string[]) { p.in = [col, ids]; return b; },
      then(ok: (r: unknown) => unknown, erro?: (e: unknown) => unknown) {
        if (tabela !== 'order_feed') return Promise.resolve({ data: null, error: null }).then(ok, erro);
        let rs = fake.linhas.filter((l) => p.filtros.every(([op, col, v]) => {
          const valor = String(l[col as keyof Linha] ?? '');
          return op === 'eq' ? valor === v : valor.toLowerCase().includes(v.replace(/^%|%$/g, '').toLowerCase());
        }));
        rs = [...rs].sort((x, y) => y.created_at.localeCompare(x.created_at) || x.origin.localeCompare(y.origin) || x.id.localeCompare(y.id));
        const [a, z] = p.range ?? [0, 999];
        const cols = (p.select ?? '').split(',');
        const data = rs.slice(a, z + 1).map((l) => Object.fromEntries(cols.map((c) => [c, l[c as keyof Linha]])));
        return Promise.resolve({ data, error: null, count: p.count === 'exact' ? rs.length : null }).then(ok, erro);
      },
    };
    return b;
  };
  return {
    supabase: {
      from: (t: string) => builder(t),
      functions: { invoke: vi.fn(async () => ({ data: { logos: {} }, error: null })) },
    },
  };
});
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isStaff: true, loading: false, role: 'employee' }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { supabase } from '@/integrations/supabase/client';
import { FEED_PAGE_SIZE, useSalesOrders } from '../useSalesOrders';

const TOTAL = 6000;
// Os pedidos-alvo moram FORA dos 5.000 mais recentes (o recorte que a tela antiga baixava).
const ALVO = 5800;

function gerarLinhas(): Linha[] {
  return Array.from({ length: TOTAL }, (_, i) => {
    const base: Omit<Linha, 'busca'> = {
      origin: 'sales',
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      created_at: new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString(),
      account: i % 2 === 0 ? 'oben' : 'colacor',
      order_number: String(10_000 + i).padStart(7, '0'),
      omie_pedido_id: 900_000 + i,
      customer_user_id: 'c1',
      customer_name: 'Cliente Genérico',
      item_names: ['Lixa 120'],
      item_quantity: 1,
      status: 'enviado',
      subtotal: 10,
      total: 10,
    };
    if (i === ALVO) {
      Object.assign(base, { customer_name: 'MARCENARIA PÔR DO SOL &amp; FILHOS', item_names: ['Afiação de Serra Circular'], total: 1234.56 });
    }
    return { ...base, busca: buscaComoAView(base) };
  });
}

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={['/sales']}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
  return renderHook(() => useSalesOrders(), { wrapper });
}

const pedidosDoFeed = () => fake.pedidos.filter((p) => p.tabela === 'order_feed');
const idAlvo = `00000000-0000-0000-0000-${String(ALVO).padStart(12, '0')}`;

async function buscar(r: ReturnType<typeof montar>['result'], termo: string) {
  fake.pedidos = [];
  act(() => r.current.setSearch(termo));
  await waitFor(() => expect(r.current.buscando).toBe(false));
  await waitFor(() => expect(r.current.search).toBe(termo));
}

beforeEach(() => {
  fake.linhas = gerarLinhas();
  fake.pedidos = [];
});

describe('useSalesOrders — abertura', () => {
  it('1 request de uma página só (sem a coluna busca), com o total contado no servidor', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orders).toHaveLength(FEED_PAGE_SIZE);
    expect(result.current.totalCount).toBe(TOTAL);
    const feed = pedidosDoFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].range).toEqual([0, FEED_PAGE_SIZE - 1]);
    expect(feed[0].count).toBe('exact');
    expect(feed[0].select?.split(',')).not.toContain('busca');
    expect(feed[0].filtros).toEqual([]);
  });

  it('rolar carrega a próxima página (sem recontar) e chega ao fim', async () => {
    fake.linhas = fake.linhas.slice(0, FEED_PAGE_SIZE + 7);
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasNextPage).toBe(true);
    fake.pedidos = [];
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.orders).toHaveLength(FEED_PAGE_SIZE + 7));
    expect(pedidosDoFeed()[0].range).toEqual([FEED_PAGE_SIZE, 2 * FEED_PAGE_SIZE - 1]);
    expect(pedidosDoFeed()[0].count).toBeUndefined();
    expect(result.current.hasNextPage).toBe(false);
  });
});

describe('useSalesOrders — busca no servidor', () => {
  it('acha o pedido além dos 5.000 mais recentes (pelo nome, com entidade HTML)', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orders.map((o) => o.id)).not.toContain(idAlvo);
    await buscar(result, 'pôr do sol & filhos');
    expect(result.current.orders.map((o) => o.id)).toEqual([idAlvo]);
    // o filtro foi pro servidor, sem o count (seria um 2º scan dos ~32 k)
    const [pedido] = pedidosDoFeed();
    expect(pedido.filtros).toEqual([['ilike', 'busca', '%por do sol & filhos%']]);
    expect(pedido.count).toBeUndefined();
    expect(result.current.totalCount).toBeNull();
  });

  it('acentos nos dois sentidos: "afiacao" e "AFIAÇÃO" acham "Afiação de Serra"', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await buscar(result, 'afiacao');
    expect(result.current.orders.map((o) => o.id)).toEqual([idAlvo]);
    await buscar(result, 'AFIAÇÃO DE SERRA');
    expect(result.current.orders.map((o) => o.id)).toEqual([idAlvo]);
  });

  it('pelo nº do pedido e pelo valor em formato BR', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await buscar(result, String(10_000 + ALVO).padStart(7, '0'));
    expect(result.current.orders.map((o) => o.id)).toEqual([idAlvo]);
    await buscar(result, '1234,56');
    expect(result.current.orders.map((o) => o.id)).toEqual([idAlvo]);
    await buscar(result, '1234.56');
    expect(result.current.orders.map((o) => o.id)).toEqual([idAlvo]);
  });

  it('só curinga (`%`, `*`) não vira match-all: não filtra nada', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await buscar(result, ' %* ');
    expect(pedidosDoFeed().every((p) => p.filtros.length === 0)).toBe(true);
    expect(result.current.totalCount).toBe(TOTAL);
  });

  it('a aba de empresa vira filtro no servidor e combina com a busca', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    fake.pedidos = [];
    act(() => result.current.setAccountFilter('oben'));
    await waitFor(() => expect(result.current.totalCount).toBe(TOTAL / 2));
    expect(pedidosDoFeed()[0].filtros).toEqual([['eq', 'account', 'oben']]);
    // o alvo (índice par) é oben; na aba colacor a mesma busca não o acha
    await buscar(result, 'afiacao');
    expect(result.current.orders.map((o) => o.id)).toEqual([idAlvo]);
    fake.pedidos = [];
    act(() => result.current.setAccountFilter('colacor'));
    await waitFor(() => expect(pedidosDoFeed().length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.buscando).toBe(false));
    expect(result.current.orders).toEqual([]);
  });
});

describe('useSalesOrders — seleção e exclusão', () => {
  it('pedido selecionado e depois escondido pela busca ainda entra no bulk delete', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const primeiro = result.current.orders[0];
    act(() => result.current.toggleSelect(primeiro, true));
    expect(result.current.selectedIds.has(primeiro.id)).toBe(true);
    await buscar(result, 'afiacao');
    expect(result.current.orders.map((o) => o.id)).not.toContain(primeiro.id);
    fake.pedidos = [];
    await act(() => result.current.deleteSelected());
    const update = fake.pedidos.find((p) => p.tabela === 'sales_orders' && p.update);
    expect(update?.in).toEqual(['id', [primeiro.id]]);
    expect(result.current.selectedIds.size).toBe(0);
  });

  it('excluir tira o pedido da lista na hora (optimistic) e reconcilia com o servidor', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const alvo = result.current.orders[3];
    // o servidor passa a não ter o pedido (soft-delete gravado)
    fake.linhas = fake.linhas.filter((l) => l.id !== alvo.id);
    fake.pedidos = [];
    await act(() => result.current.deleteOrder(alvo));
    expect(result.current.orders.map((o) => o.id)).not.toContain(alvo.id);
    await waitFor(() => expect(pedidosDoFeed().length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.totalCount).toBe(TOTAL - 1));
    expect(result.current.orders).toHaveLength(FEED_PAGE_SIZE);
  });
});

// Corrida apontada pelo Codex na revisão do #4030: exclusão individual e em lote do MESMO pedido
// se sobrepondo (os dois cliques saem do mesmo render, antes do optimistic tirar a linha).
describe('useSalesOrders — exclusão concorrente do mesmo pedido', () => {
  const invoke = vi.mocked(supabase.functions.invoke);
  type Resp = { data: unknown; error: unknown };
  const chamadasExcluir = (id: string) =>
    invoke.mock.calls.filter(([nome, opts]) =>
      nome === 'omie-vendas-sync' && (opts as { body?: { action?: string; sales_order_id?: string } })?.body?.action === 'excluir_pedido'
      && (opts as { body: { sales_order_id: string } }).body.sales_order_id === id);
  /** O Omie fica pendurado até o teste soltar — a janela da corrida fica aberta de propósito. */
  function omiePendurado(resp: Resp = { data: { success: true }, error: null }) {
    let soltar!: () => void;
    const pendente = new Promise<Resp>((r) => { soltar = () => r(resp); });
    invoke.mockImplementation((async (nome: string) =>
      nome === 'omie-vendas-sync' ? pendente : { data: { logos: {} }, error: null }) as never);
    return () => soltar();
  }
  const updatesDeSalesOrders = () => fake.pedidos.filter((p) => p.tabela === 'sales_orders' && p.update);

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((async () => ({ data: { logos: {} }, error: null })) as never);
  });

  it('individual + lote no mesmo instante: o Omie é chamado UMA vez e a trava solta no fim', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const alvo = result.current.orders[0];
    act(() => result.current.toggleSelect(alvo, true));
    const soltarOmie = omiePendurado();
    let individual!: Promise<void>;
    let lote!: Promise<void>;
    act(() => {
      individual = result.current.deleteOrder(alvo);
      lote = result.current.deleteSelected();
    });
    await waitFor(() => expect(result.current.excluindoIds.has(alvo.id)).toBe(true));
    soltarOmie();
    await act(async () => { await Promise.all([individual, lote]); });
    expect(chamadasExcluir(alvo.id)).toHaveLength(1);
    expect(result.current.excluindoIds.size).toBe(0);
  });

  it('lote em voo + individual do mesmo pedido: o individual não dispara outra exclusão', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [alvo, outro] = result.current.orders;
    act(() => { result.current.toggleSelect(alvo, true); result.current.toggleSelect(outro, true); });
    const soltarOmie = omiePendurado();
    let lote!: Promise<void>;
    act(() => { lote = result.current.deleteSelected(); });
    await waitFor(() => expect(chamadasExcluir(alvo.id)).toHaveLength(1));
    await act(() => result.current.deleteOrder(alvo)); // ex.: linha velha de outro ponto da tela
    soltarOmie();
    await act(async () => { await lote; });
    expect(chamadasExcluir(alvo.id)).toHaveLength(1);
    expect(chamadasExcluir(outro.id)).toHaveLength(1);
    expect(result.current.excluindoIds.size).toBe(0);
  });

  it('lote parcialmente travado: leva só o livre, solta só o seu, e o travado segue travado (Codex P3)', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [a, b] = result.current.orders;
    // Omie pendurado POR pedido: cada um termina quando o teste mandar.
    const soltarPor = new Map<string, () => void>();
    invoke.mockImplementation((async (nome: string, opts: { body?: { sales_order_id?: string } }) => {
      if (nome !== 'omie-vendas-sync') return { data: { logos: {} }, error: null };
      const id = opts.body!.sales_order_id!;
      return new Promise<Resp>((r) => soltarPor.set(id, () => r({ data: { success: true }, error: null })));
    }) as never);
    act(() => { result.current.toggleSelect(a, true); result.current.toggleSelect(b, true); });
    let individual!: Promise<void>;
    let lote!: Promise<void>;
    act(() => { individual = result.current.deleteOrder(a); }); // A travado pelo individual
    act(() => { lote = result.current.deleteSelected(); });     // lote [A, B] leva só B
    await waitFor(() => expect(soltarPor.has(b.id)).toBe(true));
    act(() => soltarPor.get(b.id)!());
    await act(async () => { await lote; });
    expect(result.current.excluindoIds.has(a.id)).toBe(true);  // o lote NÃO soltou o A
    expect(result.current.excluindoIds.has(b.id)).toBe(false);
    await waitFor(() => expect(soltarPor.has(a.id)).toBe(true));
    act(() => soltarPor.get(a.id)!());
    await act(async () => { await individual; });
    expect(chamadasExcluir(a.id)).toHaveLength(1);
    expect(chamadasExcluir(b.id)).toHaveLength(1);
    expect(result.current.excluindoIds.size).toBe(0);
  });

  it('rollback individual só desfaz a marca que ESTA exclusão gravou (filtra pelo carimbo)', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const alvo = result.current.orders[0];
    invoke.mockImplementation((async (nome: string) =>
      nome === 'omie-vendas-sync' ? { data: null, error: { message: 'omie down' } } : { data: { logos: {} }, error: null }) as never);
    fake.pedidos = [];
    await act(() => result.current.deleteOrder(alvo));
    const [marca, rollback] = updatesDeSalesOrders();
    const carimbo = (marca.update as { deleted_at: string }).deleted_at;
    expect(typeof carimbo).toBe('string');
    expect(rollback.update).toEqual({ deleted_at: null });
    expect(rollback.filtros).toEqual([['eq', 'id', alvo.id], ['eq', 'deleted_at', carimbo]]);
  });

  it('rollback do lote só desfaz a marca que ESTE lote gravou (filtra pelo carimbo)', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const alvo = result.current.orders[0];
    act(() => result.current.toggleSelect(alvo, true));
    invoke.mockImplementation((async (nome: string) =>
      nome === 'omie-vendas-sync' ? { data: null, error: { message: 'omie down' } } : { data: { logos: {} }, error: null }) as never);
    fake.pedidos = [];
    await act(() => result.current.deleteSelected());
    const [marca, rollback] = updatesDeSalesOrders();
    const carimbo = (marca.update as { deleted_at: string }).deleted_at;
    expect(typeof carimbo).toBe('string');
    expect(rollback.update).toEqual({ deleted_at: null });
    expect(rollback.in).toEqual(['id', [alvo.id]]);
    expect(rollback.filtros).toEqual([['eq', 'deleted_at', carimbo]]);
  });
});
