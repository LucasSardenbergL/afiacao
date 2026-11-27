// useSalesOrders: a listagem pagina e busca NO SERVIDOR (plano v4, lote 8 — C3).
// O supabase é um fake em memória com 6.000 pedidos — mais que os 5.000 que a tela antiga drenava —
// e uma coluna `busca` montada como a view a monta (migration 20261101221452): é o que prova que o
// termo que o hook manda casa com o formato da coluna, e que a busca alcança pedido fora do recorte.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Linha = {
  origin: string; id: string; created_at: string; account: string; order_number: string | null;
  omie_pedido_id: number | null; customer_user_id: string; customer_name: string | null;
  item_names: string[]; item_quantity: number; status: string; subtotal: number; total: number | null; busca: string;
  /** Só o fake sabe (a view não expõe): a "fonte" de `order_feed_do_vendedor`. */
  vendedor_user_id?: string | null;
};
type Pedido = {
  tabela: string; vendedor?: string; select?: string; count?: string; filtros: [string, string, string][]; range?: [number, number];
  update?: unknown; in?: [string, string[]]; or?: string; ordens: [string, { ascending?: boolean; nullsFirst?: boolean } | undefined][];
};

// `segurar`: enquanto houver, as respostas do order_feed esperam por ela (transição de filtro em voo).
const fake = vi.hoisted(() => ({
  linhas: [] as Linha[], pedidos: [] as Pedido[], segurar: null as Promise<void> | null,
  totais: [] as Record<string, unknown>[], erroTotal: false, efetivo: 'u1' as string | null,
  filtrarComo: null as null | ((p: Pedido) => Linha[]),
  /** `update` LANÇA (como o guard da lente faz), em vez de devolver `{ error }`. */
  lancarNoUpdate: null as Error | null,
  /** A MARCA (deleted_at não nulo) volta `{ error }` — como um 504 do proxy, que não prova nada sobre o commit. */
  erroNaMarca: false,
}));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));

// Avalia o predicado do `.or()` como o PostgREST avalia a árvore lógica: lista separada por vírgula
// no nível de cima, grupos `and(…)`/`or(…)` aninhados, valor opcionalmente entre aspas. Só os
// operadores que a listagem usa; o resto LANÇA (o fake nunca aprova o que não entende).
function dividirNoTopo(s: string): string[] {
  const partes: string[] = [];
  let prof = 0, aspas = false, ini = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') aspas = !aspas;
    else if (!aspas && c === '(') prof++;
    else if (!aspas && c === ')') prof--;
    else if (!aspas && prof === 0 && c === ',') { partes.push(s.slice(ini, i)); ini = i + 1; }
  }
  partes.push(s.slice(ini));
  return partes;
}
function comparar(col: string, a: unknown, b: string): number {
  if (col === 'created_at') return Date.parse(String(a)) - Date.parse(b);
  if (col === 'total') return Number(a) - Number(b);
  const x = String(a);
  return x < b ? -1 : x > b ? 1 : 0;
}
function casaNo(no: string, l: Linha): boolean {
  const grupo = /^(and|or)\((.*)\)$/.exec(no);
  if (grupo) {
    const filhos = dividirNoTopo(grupo[2]);
    return grupo[1] === 'and' ? filhos.every((f) => casaNo(f, l)) : filhos.some((f) => casaNo(f, l));
  }
  const [col, op, ...resto] = no.split('.');
  const v = resto.join('.').replace(/^"(.*)"$/, '$1');
  const atual = l[col as keyof Linha];
  if (op === 'is' && v === 'null') return atual === null || atual === undefined;
  if (atual === null || atual === undefined) return false; // comparação com NULL nunca casa (SQL)
  const d = comparar(col, atual, v);
  if (op === 'gte') return d >= 0;
  if (op === 'eq') return d === 0;
  if (op === 'lt') return d < 0;
  if (op === 'gt') return d > 0;
  throw new Error(`operador do .or() não previsto no fake: ${op}`);
}
function casaOr(or: string, l: Linha): boolean {
  return dividirNoTopo(or).some((c) => casaNo(c, l));
}

// O mesmo que a view faz em SQL: entidades HTML do nome, '\n' entre campos, total nos 2 formatos,
// minúsculas e sem acento.
function buscaComoAView(l: Omit<Linha, 'busca'>): string {
  const nome = (l.customer_name ?? '').replace(/&amp;/g, '&').replace(/&apos;/g, "'");
  const total = (l.total ?? 0).toFixed(2);
  return [nome, l.order_number ?? '', l.item_names.join(' '), total, total.replace('.', ',')]
    .join('\n').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

vi.mock('@/integrations/supabase/client', () => {
  const builder = (tabela: string, vendedor?: string) => {
    const p: Pedido = { tabela, vendedor, filtros: [], ordens: [] };
    fake.pedidos.push(p);
    const b = {
      select(cols: string, opts?: { count?: string }) { p.select = cols; p.count = opts?.count; return b; },
      eq(col: string, v: string) { p.filtros.push(['eq', col, v]); return b; },
      ilike(col: string, v: string) { p.filtros.push(['ilike', col, v]); return b; },
      order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) { p.ordens.push([col, opts]); return b; },
      or(f: string) { p.or = f; return b; },
      range(a: number, z: number) { p.range = [a, z]; return b; },
      update(v: unknown) {
        if (fake.lancarNoUpdate) throw fake.lancarNoUpdate;
        p.update = v; return b;
      },
      in(col: string, ids: string[]) { p.in = [col, ids]; return b; },
      then(ok: (r: unknown) => unknown, erro?: (e: unknown) => unknown) {
        if (tabela !== 'order_feed') {
          const marca = !!p.update && (p.update as { deleted_at: unknown }).deleted_at !== null;
          const error = fake.erroNaMarca && marca ? { message: 'gateway timeout' } : null;
          return Promise.resolve({ data: null, error }).then(ok, erro);
        }
        const gate = fake.segurar ?? Promise.resolve();
        return gate.then(() => responderFeed(p)).then(ok, erro);
      },
    };
    return b;
  };
  const responderFeed = (p: Pedido) => {
        let rs = filtrarComo(p);
        const porValor = p.ordens[0]?.[0] === 'total';
        rs = [...rs].sort((x, y) => (porValor ? (y.total ?? -Infinity) - (x.total ?? -Infinity) : 0) || y.created_at.localeCompare(x.created_at) || x.origin.localeCompare(y.origin) || x.id.localeCompare(y.id));
        const [a, z] = p.range ?? [0, 999];
        const cols = (p.select ?? '').split(',');
        // `alias:coluna::text` (o cursor do total) sai como o PostgREST o devolve: texto exato.
        const valor = (l: Linha, c: string) => {
          const m = /^(\w+):(\w+)::text$/.exec(c);
          return m ? [m[1], String(l[m[2] as keyof Linha])] : [c, l[c as keyof Linha]];
        };
        const data = rs.slice(a, z + 1).map((l) => Object.fromEntries(cols.map((c) => valor(l, c))));
        return { data, error: null, count: p.count === 'exact' ? rs.length : null };
  };
  // As linhas que os filtros GRAVADOS de um pedido trazem (sem ordem nem página) — é o que a paridade
  // compara com a RPC do valor.
  const filtrarComo = (p: Pedido) => {
        const fonte = p.vendedor ? fake.linhas.filter((l) => l.origin === 'sales' && l.vendedor_user_id === p.vendedor) : fake.linhas;
        let rs = fonte.filter((l) => p.filtros.every(([op, col, v]) => {
          const valor = String(l[col as keyof Linha] ?? '');
          return op === 'eq' ? valor === v : valor.toLowerCase().includes(v.replace(/^%|%$/g, '').toLowerCase());
        }));
        if (p.in && p.in[0] === 'status') rs = rs.filter((l) => p.in![1].includes(l.status));
        if (p.or) rs = rs.filter((l) => casaOr(p.or!, l));
        return rs;
  };
  fake.filtrarComo = filtrarComo;
  // order_feed_total escrito como o SQL da migration (parâmetro a parâmetro), INDEPENDENTE dos filtros
  // que o hook grava no builder: se o hook derivar params e filtros de fontes diferentes, divergem.
  const totalComoOSql = (a: Record<string, unknown>) => {
    const fonte = a.p_vendedor ? fake.linhas.filter((l) => l.origin === 'sales' && l.vendedor_user_id === a.p_vendedor) : fake.linhas;
    const rs = fonte.filter((l) =>
      (a.p_account == null || l.account === a.p_account)
      && (a.p_status == null || (a.p_status as string[]).includes(l.status))
      && (a.p_desde == null || Date.parse(l.created_at) >= Date.parse(String(a.p_desde))
          || ((a.p_puros as string[] | null) ?? []).some((x) => Date.parse(x) === Date.parse(l.created_at)))
      && (a.p_customer == null || l.customer_user_id === a.p_customer)
      && (a.p_busca == null || l.busca.includes(String(a.p_busca).replace(/^%|%$/g, ''))));
    const conhecidos = rs.filter((l) => l.total !== null);
    return {
      pedidos: rs.length,
      soma: conhecidos.length ? Math.round(conhecidos.reduce((t, l) => t + (l.total as number), 0) * 100) / 100 : null,
      sem_total: rs.length - conhecidos.length,
    };
  };
  return {
    supabase: {
      from: (t: string) => builder(t),
      rpc: (nome: string, args: Record<string, unknown>, opts?: { count?: string }) => {
        if (nome === 'order_feed_do_vendedor') {
          const b = builder('order_feed', String(args.p_vendedor));
          const sel = b.select.bind(b);
          // `.rpc(…, {count}).select(cols)`: o count vem nas opções da rpc, não no select.
          b.select = (cols: string) => sel(cols, { count: opts?.count });
          return b;
        }
        if (nome === 'order_feed_total') {
          fake.totais.push(args);
          if (fake.erroTotal) return Promise.resolve({ data: null, error: { message: 'boom' } });
          return Promise.resolve({ data: [totalComoOSql(args)], error: null });
        }
        throw new Error(`rpc não prevista no fake: ${nome}`);
      },
      functions: { invoke: vi.fn(async () => ({ data: { logos: {} }, error: null })) },
    },
  };
});
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isStaff: true, loading: false, role: 'employee' }),
}));
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ effectiveUserId: fake.efetivo, isImpersonating: fake.efetivo !== 'u1' }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ track: analytics.track }));

import { supabase } from '@/integrations/supabase/client';
import { FEED_PAGE_SIZE, useDiaDeHoje, useSalesOrders } from '../useSalesOrders';
import { filtroDoPeriodo } from '../feed';
import { diaDoPedido } from '@/lib/pedido/data-pedido';
import { format } from 'date-fns';

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

function montar(url = '/sales') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[url]}>
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
  fake.totais = [];
  fake.erroTotal = false;
  fake.efetivo = 'u1';
  fake.pedidos = [];
  fake.segurar = null;
  fake.lancarNoUpdate = null;
  fake.erroNaMarca = false;
  analytics.track.mockClear();
});

describe('useSalesOrders — abertura', () => {
  it('1 request de uma página só (sem a coluna busca), com o total contado no servidor', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orders).toHaveLength(FEED_PAGE_SIZE);
    await waitFor(() => expect(result.current.totalCount).toBe(TOTAL));
    const feed = pedidosDoFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].range).toEqual([0, FEED_PAGE_SIZE - 1]);
    // A contagem é a do valor do recorte (order_feed_total): a página não conta de novo (revisão /sales #34).
    expect(feed[0].count).toBeUndefined();
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
    // cursor, não offset: a 2ª página pede de novo as 50 primeiras DEPOIS da última linha lida
    expect(pedidosDoFeed()[0].range).toEqual([0, FEED_PAGE_SIZE - 1]);
    expect(pedidosDoFeed()[0].or).toBeTruthy();
    expect(pedidosDoFeed()[0].count).toBeUndefined();
    expect(result.current.hasNextPage).toBe(false);
  });
});

// Ordem que a view aplica, escrita à parte do fake (comparação de string por unidade de código).
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function ordenar(ls: Linha[], porValor = false): string[] {
  return [...ls]
    .sort((x, y) => (porValor ? (y.total ?? 0) - (x.total ?? 0) : 0) || -cmp(x.created_at, y.created_at) || cmp(x.origin, y.origin) || cmp(x.id, y.id))
    .map((l) => l.id);
}
async function rolarAte(r: ReturnType<typeof montar>['result'], n: number) {
  while (r.current.orders.length < n && r.current.hasNextPage) {
    const antes = r.current.orders.length;
    await act(() => r.current.fetchNextPage());
    await waitFor(() => expect(r.current.isFetchingNextPage).toBe(false));
    if (r.current.orders.length === antes) break;
  }
}

describe('useSalesOrders — paginação por cursor (keyset)', () => {
  it('pedido excluído no servidor numa página já lida NÃO faz o seguinte sumir na próxima', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const esperado = ordenar(fake.linhas).slice(0, 2 * FEED_PAGE_SIZE + 1);
    // Outra pessoa exclui o 10º pedido da 1ª página (já na tela): com offset, o antigo 51º viraria
    // o 50º e a 2ª página começaria no 52º — o 51º sumiria sem sinal.
    const excluido = esperado[9];
    fake.linhas = fake.linhas.filter((l) => l.id !== excluido);
    await rolarAte(result, 2 * FEED_PAGE_SIZE);
    const ids = result.current.orders.map((o) => o.id);
    expect(ids).toContain(esperado[FEED_PAGE_SIZE]); // o antigo 51º
    expect(ids).toEqual(esperado.slice(0, 2 * FEED_PAGE_SIZE));
  });

  it('created_at empatado entre a 50ª e a 51ª linha: desempata por origin/id sem pular nem repetir', async () => {
    // 12 pedidos no MESMO instante (a data-pura 12:00Z do Omie — 15 empatados na prod), dos dois
    // origins, atravessando a fronteira da página.
    const mesmo = fake.linhas[44].created_at;
    fake.linhas = fake.linhas.map((l, i) =>
      i >= 44 && i < 56 ? { ...l, created_at: mesmo, origin: i % 3 === 0 ? 'afiacao' : 'sales' } : l,
    );
    const esperado = ordenar(fake.linhas).slice(0, 3 * FEED_PAGE_SIZE);
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await rolarAte(result, 3 * FEED_PAGE_SIZE);
    expect(result.current.orders.map((o) => o.id)).toEqual(esperado);
  });

  it('"Maior valor": o cursor muda de eixo (total) e pagina certo com valor empatado na fronteira', async () => {
    // Valores em degraus de 30 pedidos: TODA fronteira de página cai no meio de um empate de total,
    // e dentro do degrau o created_at desempata.
    fake.linhas = fake.linhas.slice(0, 400).map((l, i) => ({ ...l, total: 1000 - Math.floor(i / 30) * 10.25 }));
    fake.linhas.reverse(); // a ordem de inserção não ajuda o fake
    const esperado = ordenar(fake.linhas, true).slice(0, 4 * FEED_PAGE_SIZE);
    const { result } = montar('/sales?ordem=valor');
    await waitFor(() => expect(result.current.loading).toBe(false));
    await rolarAte(result, 4 * FEED_PAGE_SIZE);
    expect(result.current.orders.map((o) => o.id)).toEqual(esperado);
    expect(pedidosDoFeed().at(-1)?.or).toContain('total.lt.');
  });

  it('cursor + período vão num `.or()` só (and de or), e o período segue cortando nas páginas seguintes', async () => {
    const agora = Date.now();
    fake.linhas = fake.linhas.map((l, i) => ({ ...l, created_at: new Date(agora - i * 60_000).toISOString() }));
    const { result } = montar('/sales?periodo=30d');
    await waitFor(() => expect(result.current.loading).toBe(false));
    fake.pedidos = [];
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.isFetchingNextPage).toBe(false));
    const or = pedidosDoFeed()[0].or ?? '';
    expect(or.startsWith('and(or(created_at.gte.')).toBe(true);
  });

  it('o optimistic da exclusão não encerra a rolagem nem recua o cursor', async () => {
    fake.linhas = fake.linhas.slice(0, FEED_PAGE_SIZE + 7);
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    let soltar!: () => void;
    fake.segurar = new Promise((r) => { soltar = r; }); // a reconciliação fica em voo
    await act(() => result.current.deleteOrder(result.current.orders[FEED_PAGE_SIZE - 1]));
    expect(result.current.orders).toHaveLength(FEED_PAGE_SIZE - 1);
    // a página tem 49 linhas na tela, mas veio CHEIA do servidor: ainda há mais
    expect(result.current.hasNextPage).toBe(true);
    fake.segurar = null;
    soltar();
    await waitFor(() => expect(result.current.orders).toHaveLength(FEED_PAGE_SIZE));
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
    // Com busca o rodapé também tem o total: vem da RPC do valor, mesmos filtros (revisão /sales #34).
    await waitFor(() => expect(result.current.totalCount).toBe(1));
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

describe('useSalesOrders — filtros de status, período e ordem (no servidor)', () => {
  const ultimoFeed = () => pedidosDoFeed().at(-1)!;
  async function aplicar(r: ReturnType<typeof montar>['result'], f: () => void) {
    fake.pedidos = [];
    act(f);
    await waitFor(() => expect(pedidosDoFeed().length).toBeGreaterThan(0));
    await waitFor(() => expect(r.current.buscando).toBe(false));
  }

  it('"Rascunhos" vira .eq(status) e "Faturados" vira .in(status) — e a lista só traz esses', async () => {
    fake.linhas[3].status = 'rascunho';
    fake.linhas[4].status = 'faturado';
    fake.linhas[5].status = 'entregue';
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await aplicar(result, () => result.current.setStatusFilter('rascunhos'));
    expect(ultimoFeed().filtros).toContainEqual(['eq', 'status', 'rascunho']);
    expect(result.current.orders.map((o) => o.id)).toEqual([fake.linhas[3].id]);

    await aplicar(result, () => result.current.setStatusFilter('faturados'));
    expect(ultimoFeed().in).toEqual(['status', ['faturado', 'entregue']]);
    expect(result.current.orders.map((o) => o.status).sort()).toEqual(['entregue', 'faturado']);
    expect(analytics.track).toHaveBeenCalledWith('sales.lista_filtro', { tipo: 'status', valor: 'faturados' });
  });

  it('"Maior valor" ordena por total DESC com ausente no fim, antes da ordem estável', async () => {
    fake.linhas[10].total = 99_999;
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await aplicar(result, () => result.current.setOrdem('valor'));
    expect(ultimoFeed().ordens[0]).toEqual(['total', { ascending: false, nullsFirst: false }]);
    expect(ultimoFeed().ordens.map(([c]) => c)).toEqual(['total', 'created_at', 'origin', 'id']);
    expect(result.current.orders[0].id).toBe(fake.linhas[10].id);
  });

  it('período corta pelo DIA CIVIL de diaDoPedido (data-pura UTC × hora local), no fuso do processo', async () => {
    const agora = new Date();
    const hoje = format(agora, 'yyyy-MM-dd');
    const [a, m, d] = hoje.split('-').map(Number);
    const inicioLocal = new Date(a, m - 1, d).getTime();
    // Instantes nas bordas: data-pura de hoje às 00:00Z e 12:00Z, data-pura de ontem, wizard 1 min
    // antes e 1 min depois da meia-noite local, wizard 3h antes da meia-noite local.
    const instantes = [
      Date.UTC(a, m - 1, d, 0), Date.UTC(a, m - 1, d, 12), Date.UTC(a, m - 1, d - 1, 12), Date.UTC(a, m - 1, d - 1, 0),
      inicioLocal - 60_000, inicioLocal + 60_000, inicioLocal - 3 * 3_600_000 + 1,
    ];
    fake.linhas = instantes.map((t, i) => ({ ...fake.linhas[i], created_at: new Date(t).toISOString() }));
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await aplicar(result, () => result.current.setPeriodo('hoje'));

    expect(ultimoFeed().or).toBe(filtroDoPeriodo('hoje'));
    const esperado = fake.linhas.filter((l) => diaDoPedido(l.created_at)! >= hoje).map((l) => l.id).sort();
    expect(esperado.length).toBeGreaterThan(0);
    expect(result.current.orders.map((o) => o.id).sort()).toEqual(esperado);
  });

  it('"Limpar filtros" zera busca, empresa, status, período e ordem numa escrita só', async () => {
    // Abre JÁ filtrado: a key padrão não está em cache, então o Limpar tem de ir ao servidor.
    const { result } = montar('/sales?q=serra&empresa=oben&status=cancelados&periodo=7d&ordem=valor');
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toMatchObject({ accountFilter: 'oben', statusFilter: 'cancelados', periodo: '7d', ordem: 'valor', comFiltro: true });
    expect(ultimoFeed().or).toBeTruthy();

    await aplicar(result, () => result.current.limparFiltros());
    expect(result.current).toMatchObject({
      search: '', accountFilter: 'all', statusFilter: 'todos', periodo: 'tudo', ordem: 'recentes', comFiltro: false,
    });
    const f = ultimoFeed();
    expect(f.filtros).toEqual([]);
    expect(f.in).toBeUndefined();
    expect(f.or).toBeUndefined();
    expect(f.ordens[0][0]).toBe('created_at');
  });

  it('só o filtro de período ou de status já conta como "com filtros"', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setPeriodo('30d'));
    await waitFor(() => expect(result.current.comFiltro).toBe(true));
  });
});

describe('useSalesOrders — troca de filtro com a lista anterior na tela (isPlaceholderData)', () => {
  it('suspende a seleção sem perder a já feita, e solta quando a resposta nova chega', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [a, b] = result.current.orders;
    act(() => result.current.toggleSelect(a, true));

    let liberar!: () => void;
    fake.segurar = new Promise<void>((r) => { liberar = r; });
    act(() => result.current.setAccountFilter('colacor'));
    await waitFor(() => expect(result.current.buscando).toBe(true));

    // Linhas na tela são da aba ANTERIOR: nem entram nem saem da seleção.
    act(() => result.current.toggleSelect(b, true));
    act(() => result.current.toggleSelect(a, false));
    expect([...result.current.selectedIds]).toEqual([a.id]);

    fake.segurar = null;
    liberar();
    await waitFor(() => expect(result.current.buscando).toBe(false));
    act(() => result.current.toggleSelect(result.current.orders[0], true));
    expect(result.current.selectedIds.size).toBe(2);
  });
});

describe('useSalesOrders — medição da busca', () => {
  it('manda só se achou algo, nunca o termo, uma vez por termo', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await buscar(result, 'zzz-nao-existe');
    await waitFor(() => expect(analytics.track).toHaveBeenCalledWith('sales.lista_busca', { tem_resultado: false }));
    await buscar(result, 'marcenaria');
    await waitFor(() => expect(analytics.track).toHaveBeenCalledWith('sales.lista_busca', { tem_resultado: true }));
    const buscas = analytics.track.mock.calls.filter(([e]) => e === 'sales.lista_busca');
    expect(buscas).toHaveLength(2);
    expect(JSON.stringify(analytics.track.mock.calls)).not.toMatch(/marcenaria|zzz/);
  });
});

describe('useSalesOrders — pedidos de UM cliente (?customer=, vindo da ficha)', () => {
  const CLIENTE = '11111111-2222-4333-8444-555555555555';

  it('?customer=<uuid> vira filtro no servidor por customer_user_id', async () => {
    const { result } = montar(`/sales?customer=${CLIENTE}`);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.clienteFiltro).toBe(CLIENTE);
    expect(result.current.comFiltro).toBe(true);
    expect(pedidosDoFeed()[0].filtros).toContainEqual(['eq', 'customer_user_id', CLIENTE]);
  });

  it('valor torto no ?customer= é ignorado (cai em todos), nunca vai ao servidor', async () => {
    const { result } = montar('/sales?customer=nao-e-uuid');
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.clienteFiltro).toBeNull();
    expect(pedidosDoFeed()[0].filtros).toEqual([]);
  });

  it('limparCliente tira o filtro e a lista volta a todos (key nova)', async () => {
    const { result } = montar(`/sales?customer=${CLIENTE}`);
    await waitFor(() => expect(result.current.loading).toBe(false));
    fake.pedidos = [];
    act(() => result.current.limparCliente());
    await waitFor(() => expect(result.current.clienteFiltro).toBeNull());
    await waitFor(() => expect(pedidosDoFeed().length).toBeGreaterThan(0));
    expect(pedidosDoFeed().at(-1)?.filtros).toEqual([]);
  });
});

describe('useSalesOrders — "Meus pedidos" e valor do recorte', () => {
  // `comNulos`: total ausente em 1 de cada 13 (a soma sai parcial). Só onde a lista não é RENDERIZADA:
  // a linha da lista exige `total` (COLUNAS_FEED_EXIGIDAS) — na prod é NOT NULL nas duas tabelas.
  const marcarVendedores = (comNulos = false) => {
    fake.linhas = fake.linhas.map((l, i) => ({
      ...l, vendedor_user_id: i % 3 === 0 ? 'u1' : i % 3 === 1 ? 'u2' : null,
      status: i % 5 === 0 ? 'faturado' : i % 7 === 0 ? 'cancelado' : i % 11 === 0 ? 'rascunho' : l.status,
      total: comNulos && i % 13 === 0 ? null : l.total,
    }));
  };

  it('?meus=1 lê de order_feed_do_vendedor com o usuário EFETIVO da lente, com os mesmos filtros', async () => {
    marcarVendedores();
    fake.efetivo = 'u2'; // "Ver como" u2: a leitura é do vendedor efetivo, não do usuário real (u1)
    const { result } = montar('/sales?meus=1&empresa=oben&status=faturados');
    await waitFor(() => expect(result.current.loading).toBe(false));
    const p = pedidosDoFeed()[0];
    expect(p.vendedor).toBe('u2');
    expect(p.filtros).toContainEqual(['eq', 'account', 'oben']);
    expect(p.in).toEqual(['status', ['faturado', 'entregue']]);
    expect(result.current.orders.length).toBeGreaterThan(0);
    expect(result.current.orders.every((o) => fake.linhas.find((l) => l.id === o.id)?.vendedor_user_id === 'u2')).toBe(true);
    expect(fake.totais.at(-1)).toMatchObject({ p_vendedor: 'u2', p_account: 'oben', p_status: ['faturado', 'entregue'] });
  });

  it('"Meus" sem usuário efetivo NÃO consulta nada (vendedor nulo abriria todos os pedidos)', async () => {
    fake.efetivo = null;
    const { result } = montar('/sales?meus=1');
    await new Promise((r) => setTimeout(r, 30));
    expect(pedidosDoFeed()).toHaveLength(0);
    expect(fake.totais).toHaveLength(0);
    expect(result.current.meusAguardando).toBe(true);
    expect(result.current.valorRecorte).toEqual({ estado: 'carregando' });
  });

  it('ligar/desligar "Meus" escreve na URL, mede o filtro e conta como filtro ativo', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.comFiltro).toBe(false);
    act(() => result.current.setMeus(true));
    await waitFor(() => expect(result.current.meus).toBe(true));
    expect(result.current.comFiltro).toBe(true);
    expect(analytics.track).toHaveBeenCalledWith('sales.lista_filtro', { tipo: 'meus', valor: '1' });
    act(() => result.current.limparFiltros());
    await waitFor(() => expect(result.current.meus).toBe(false));
  });

  // PARIDADE (lado TS): a RPC do valor recebe params derivados do MESMO recorte que monta os filtros
  // da lista. O fake soma pela leitura dos PARAMS (como o SQL) e a lista é refeita pelos FILTROS
  // gravados no builder — se uma das duas pontas esquecer um filtro, os números divergem.
  it.each([
    '/sales',
    '/sales?empresa=colacor',
    '/sales?status=faturados',
    '/sales?status=rascunhos',
    '/sales?status=cancelados&empresa=oben',
    '/sales?periodo=30d',
    '/sales?q=generico',
    '/sales?meus=1',
    '/sales?meus=1&status=faturados&empresa=oben&q=lixa',
    '/sales?customer=00000000-0000-0000-0000-0000000000c1',
  ])('paridade valor × filtros da lista: %s', async (url) => {
    marcarVendedores(true);
    const agora = Date.now();
    fake.linhas = fake.linhas.map((l, i) => ({ ...l, created_at: new Date(agora - i * 3_600_000).toISOString(),
      customer_user_id: i % 4 === 0 ? '00000000-0000-0000-0000-0000000000c1' : l.customer_user_id }));
    const { result } = montar(url);
    await waitFor(() => expect(result.current.valorRecorte.estado).toBe('ok'));
    await waitFor(() => expect(pedidosDoFeed().length).toBeGreaterThan(0));
    const lista = fake.filtrarComo!(pedidosDoFeed()[0]);
    const conhecidos = lista.filter((l) => l.total !== null);
    const v = result.current.valorRecorte;
    if (v.estado !== 'ok') throw new Error('valor não carregou');
    expect(v.pedidos).toBe(lista.length);
    expect(v.semTotal).toBe(lista.length - conhecidos.length);
    expect(v.soma).toBe(conhecidos.length ? Math.round(conhecidos.reduce((t, l) => t + (l.total as number), 0) * 100) / 100 : null);
    expect(lista.length).toBeGreaterThan(0); // paridade de recorte vazio seria trivial
    if (!url.includes('status=rascunhos')) expect(v.semTotal).toBeGreaterThan(0); // a soma parcial também é exercida
  });

  it('erro da RPC vira estado de erro — nunca 0', async () => {
    fake.erroTotal = true;
    const { result } = montar();
    await waitFor(() => expect(result.current.valorRecorte).toEqual({ estado: 'erro' }));
  });
});


// Revisão /sales, leva 3.
describe('useSalesOrders — leva 3 da revisão /sales', () => {
  it('#14: "Meus" esperando o usuário efetivo não serve o cache de "Todos" como se fosse dele', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    fake.efetivo = null; // a lente ainda resolvendo o vendedor efetivo
    fake.pedidos = [];
    act(() => result.current.setMeus(true));
    await waitFor(() => expect(result.current.meus).toBe(true));
    expect(result.current.meusAguardando).toBe(true);
    // Chave própria: o que estiver na tela é PLACEHOLDER do recorte anterior (ações suspensas), nunca
    // um acerto de cache de "Todos" com cara de "Meus" (com a chave igual, buscando ficava false).
    expect(result.current.buscando).toBe(true);
    expect(pedidosDoFeed()).toHaveLength(0);
  });

  it('#20: exclusão cuja escrita LANÇA (guard da lente) devolve a linha ao cache e não estoura', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const alvo = result.current.orders[2];
    fake.lancarNoUpdate = new Error('LANCOU_NO_UPDATE');
    await act(() => result.current.deleteOrder(alvo));
    await waitFor(() => expect(result.current.orders.map((o) => o.id)).toContain(alvo.id));
    expect(result.current.excluindoIds.size).toBe(0);
    const { toast } = await import('sonner');
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Erro ao excluir', expect.anything());
  });

  it('#36: lote grande vai em fatias de no máximo 100 ids (marca e rollback)', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const base = result.current.orders[0];
    const ids = Array.from({ length: 150 }, (_, i) => `11111111-0000-0000-0000-${String(i).padStart(12, '0')}`);
    act(() => { for (const id of ids) result.current.toggleSelect({ ...base, id }, true); });
    const invoke = vi.mocked(supabase.functions.invoke);
    invoke.mockImplementation((async (nome: string) =>
      nome === 'omie-vendas-sync' ? { data: null, error: new Error('omie fora') } : { data: { logos: {} }, error: null }) as never);
    fake.pedidos = [];
    await act(() => result.current.deleteSelected());
    const updates = fake.pedidos.filter((p) => p.tabela === 'sales_orders' && p.update);
    const marcas = updates.filter((p) => (p.update as { deleted_at: string | null }).deleted_at !== null);
    const rollbacks = updates.filter((p) => (p.update as { deleted_at: string | null }).deleted_at === null);
    expect(marcas.map((p) => p.in?.[1].length)).toEqual([100, 50]);
    expect(rollbacks.map((p) => p.in?.[1].length)).toEqual([100, 50]);
    expect(new Set(marcas.flatMap((p) => p.in?.[1] ?? []))).toEqual(new Set(ids));
    invoke.mockReset();
    invoke.mockImplementation((async () => ({ data: { logos: {} }, error: null })) as never);
  });
});

describe('useSalesOrders — leva 3, revisão adversarial', () => {
  it('marca do lote que volta { error } é desfeita pelo carimbo (pode ter gravado) e nada vai ao Omie', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.loading).toBe(false));
    const alvo = { ...result.current.orders[0], status: 'rascunho', omie_pedido_id: null };
    act(() => result.current.toggleSelect(alvo, true));
    fake.erroNaMarca = true;
    fake.pedidos = [];
    const invoke = vi.mocked(supabase.functions.invoke);
    invoke.mockClear();
    await act(() => result.current.deleteSelected());
    const updates = fake.pedidos.filter((p) => p.tabela === 'sales_orders' && p.update);
    const rollback = updates.find((p) => (p.update as { deleted_at: unknown }).deleted_at === null);
    expect(rollback?.in).toEqual(['id', [alvo.id]]);
    expect(invoke.mock.calls.filter(([n]) => n === 'omie-vendas-sync')).toHaveLength(0);
  });

  it('com a lista do recorte anterior na tela (placeholder), o rodapé não usa o total do novo', async () => {
    const { result } = montar();
    await waitFor(() => expect(result.current.totalCount).toBe(TOTAL));
    let soltar!: () => void;
    fake.segurar = new Promise<void>((r) => { soltar = r; });
    act(() => result.current.setStatusFilter('faturados'));
    await waitFor(() => expect(result.current.buscando).toBe(true));
    await new Promise((r) => setTimeout(r, 30)); // o total (sem gate) já respondeu
    expect(result.current.totalCount).toBeNull();
    fake.segurar = null;
    soltar();
    await waitFor(() => expect(result.current.buscando).toBe(false));
  });
});

describe('useDiaDeHoje (#31)', () => {
  afterEach(() => vi.useRealTimers());
  it('vira sozinho na virada do dia local, sem outro render', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 25, 23, 59, 30));
    const { result } = renderHook(() => useDiaDeHoje());
    expect(result.current).toBe('2026-11-25');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current).toBe('2026-11-26');
    act(() => { vi.advanceTimersByTime(24 * 60 * 60 * 1000); });
    expect(result.current).toBe('2026-11-27');
  });

  it('Mac acordando da suspensão (relógio pulou, timer parado): vira ao voltar à aba', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 25, 18, 0));
    const { result } = renderHook(() => useDiaDeHoje());
    vi.setSystemTime(new Date(2026, 10, 26, 9, 0)); // sem avançar os timers
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current).toBe('2026-11-26');
  });
});
