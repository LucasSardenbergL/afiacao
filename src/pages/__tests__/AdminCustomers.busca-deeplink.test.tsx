import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Incidente 2026-10-09 (prod, master, base completa): a busca e o deep link da lista de
 * clientes só enxergavam as páginas JÁ CARREGADAS no navegador.
 *  - buscar "HELIOMAR" → "Nenhum cliente com esses filtros" (o cliente existe);
 *  - /admin/customers/<id fora das páginas carregadas> → caía na LISTA, sem ficha nem aviso.
 *
 * O scope roda de verdade; só o supabase é mockado, gravando a cadeia de cada query.
 */

type Op = [string, unknown[]];
/** `table` = tabela do `.from()`, ou `rpc:<nome>` com `args` para `.rpc()`. */
interface Chamada { table: string; ops: Op[]; args?: Record<string, unknown> }

const h = vi.hoisted(() => ({
  modo: 'completa' as 'completa' | 'carteira',
  chamadas: [] as { table: string; ops: [string, unknown[]][]; args?: Record<string, unknown> }[],
  alvoPorId: null as Record<string, unknown> | null,
  /** Segura a 1ª página da base até ser liberada — simula a lista mais lenta que a leitura por id. */
  liberarBase: null as null | (() => void),
  atrasarBase: false,
  /** Carteira semeada (onda 1): perfis e linhas de farmer_client_scores. `null` = o WALTER de sempre. */
  carteira: null as Record<string, unknown>[] | null,
  scores: [] as Record<string, unknown>[],
}));

const perfil = (user_id: string, name: string) => ({
  user_id, name, email: null, phone: null, document: null,
  customer_type: 'pj', created_at: '2026-07-01T00:00:00Z', requires_po: false,
});
// 1ª página da base: só o topo alfabético. HELIOMAR está "mais adiante" na base.
const WALTER = perfil('2a4b187c-4639-4c46-8d00-81db170f93b4', 'WALTER JOSE NOGUEIRA');
const HELIOMAR = perfil('fa2df777-ee84-460a-a606-6f0e117ad663', 'JOSE HELIOMAR MARTINS JUNIOR');

const tem = (ops: Op[], m: string) => ops.some(([n]) => n === m);

function resposta(c: Chamada): unknown {
  if (c.table === 'rpc:listar_clientes_base') {
    // Servidor simulado: a busca casa HELIOMAR, que NÃO está nas páginas carregadas sem busca;
    // o filtro "critico" casa 37 clientes no recorte inteiro (só 1 vem nesta página).
    if (c.args?.p_busca) return { data: [{ ...HELIOMAR, prioridade_ordenacao: 40, total: 1 }], error: null };
    if (c.args?.p_saude === 'critico') return { data: [{ ...HELIOMAR, prioridade_ordenacao: 40, total: 37 }], error: null };
    return { data: [{ ...WALTER, prioridade_ordenacao: 60, total: 5665 }], error: null };
  }
  if (c.table === 'profiles') {
    if (tem(c.ops, 'maybeSingle')) return { data: h.alvoPorId, error: null };
    if (tem(c.ops, 'in')) return { data: h.carteira ?? [WALTER], error: null };
    return { data: [WALTER], error: null, count: 5665 };
  }
  if (c.table === 'carteira_assignments') {
    return { data: (h.carteira ?? [WALTER]).map((p) => ({ customer_user_id: p.user_id, owner_user_id: 'staff-1' })), error: null };
  }
  if (c.table === 'farmer_client_scores') return { data: h.scores, error: null };
  return { data: [], error: null, count: 0 };
}

function chain(table: string, args?: Record<string, unknown>): unknown {
  const registro: Chamada = { table, ops: [], args };
  h.chamadas.push(registro);
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) c[m] = (...args: unknown[]) => { registro.ops.push([m, args]); return c; };
  c.then = (resolve: (v: unknown) => void) => {
    const ehPaginaBase = table === 'rpc:listar_clientes_base';
    if (h.atrasarBase && ehPaginaBase) {
      h.liberarBase = () => resolve(resposta(registro));
      return;
    }
    resolve(resposta(registro));
  };
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: (fn: string, args?: Record<string, unknown>) => chain(`rpc:${fn}`, args),
  },
}));
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'staff-1' };
  return { useAuth: () => ({ user, isStaff: true, loading: false }) };
});
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: 'staff-1' }),
}));
vi.mock('@/hooks/useDisplayAccess', () => ({
  useDisplayAccess: () => ({
    displayIsMaster: h.modo === 'completa', displayIsGestorComercial: false,
    displayIsSalesOnly: h.modo === 'carteira', displayLoading: false,
  }),
}));
// A ficha 360 tem dependências próprias (telefonia, visitas…) fora do escopo deste teste.
vi.mock('@/components/adminCustomers/Customer360View', () => ({
  Customer360View: ({ customer }: { customer: { name: string } }) => <div>ficha: {customer.name}</div>,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import AdminCustomers from '../AdminCustomers';
import { useClientesScope } from '@/components/adminCustomers/useClientesScope';

const renderEm = (url: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/admin/customers" element={<AdminCustomers />} />
          <Route path="/admin/customers/:customerId" element={<AdminCustomers />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const queriesDeProfiles = () => h.chamadas.filter((c) => c.table === 'profiles');
const paginasDaBase = () => h.chamadas.filter((c) => c.table === 'rpc:listar_clientes_base');

beforeEach(() => {
  h.carteira = null;
  h.scores = [];
  h.modo = 'completa';
  h.chamadas.length = 0;
  h.alvoPorId = null;
  h.atrasarBase = false;
  h.liberarBase = null;
  vi.clearAllMocks();
});

describe('AdminCustomers — busca na base completa vai ao servidor', () => {
  it('termo na URL: a busca vai à RPC e mostra quem está fora das páginas carregadas', async () => {
    renderEm('/admin/customers?search=HELIOMAR');

    expect(await screen.findByText('JOSE HELIOMAR MARTINS JUNIOR')).toBeTruthy();
    expect(screen.queryByText(/Nenhum cliente com esses filtros/i)).toBeNull();

    const busca = paginasDaBase().find((c) => c.args?.p_busca === 'HELIOMAR');
    expect(busca, 'a busca não foi ao servidor').toBeTruthy();
    // Paginação no servidor, dentro do teto de 1.000 do PostgREST (a ordem total mora na RPC,
    // provada em db/test-listar-clientes-base.sh).
    expect(busca!.args).toMatchObject({ p_limite: 100, p_offset: 0, p_ordem: 'prioridade' });
    // A base não é mais lida crua por página (só count/head e leitura por id).
    expect(queriesDeProfiles().some((c) => tem(c.ops, 'range'))).toBe(false);
  });

  it('digitar no campo dispara a busca no servidor (após o debounce)', async () => {
    renderEm('/admin/customers');
    await screen.findByText('WALTER JOSE NOGUEIRA');

    fireEvent.change(screen.getByPlaceholderText(/Buscar por nome/i), { target: { value: 'HELIOMAR' } });

    expect(await screen.findByText('JOSE HELIOMAR MARTINS JUNIOR')).toBeTruthy();
    // O input sobreviveu (a página não virou skeleton durante a troca de termo).
    expect((screen.getByPlaceholderText(/Buscar por nome/i) as HTMLInputElement).value).toBe('HELIOMAR');
  });

  it('carteira: busca segue LOCAL (sem query nova que alargue o escopo)', async () => {
    h.modo = 'carteira';
    renderEm('/admin/customers?search=HELIOMAR');

    expect(await screen.findByText(/Nenhum cliente com esses filtros/i)).toBeTruthy();
    expect(paginasDaBase()).toHaveLength(0);
    expect(queriesDeProfiles().some((c) => tem(c.ops, 'or'))).toBe(false);
  });
});

describe('AdminCustomers — ordem e filtro de saúde no servidor (base completa)', () => {
  it('abre em "Priorizar contatos": a 1ª página já vem ordenada por prioridade', async () => {
    renderEm('/admin/customers');
    await screen.findByText('WALTER JOSE NOGUEIRA');

    expect(paginasDaBase()[0].args).toMatchObject({ p_ordem: 'prioridade', p_offset: 0 });
    expect(paginasDaBase()[0].args?.p_saude).toBeUndefined();
    expect(screen.getByRole('button', { name: /Ordenar lista/i }).textContent).toMatch(/Priorizar contatos/);
  });

  it('?ordem=nome pede A–Z ao servidor', async () => {
    renderEm('/admin/customers?ordem=nome');
    await screen.findByText('WALTER JOSE NOGUEIRA');

    expect(paginasDaBase().at(-1)!.args).toMatchObject({ p_ordem: 'nome' });
  });

  it('clicar no cabeçalho "Cliente" troca a ordem para A–Z no servidor', async () => {
    renderEm('/admin/customers');
    await screen.findByText('WALTER JOSE NOGUEIRA');

    fireEvent.click(screen.getByRole('button', { name: /^Cliente/ }));
    await waitFor(() => { expect(paginasDaBase().at(-1)!.args).toMatchObject({ p_ordem: 'nome' }); });
  });

  it('?health=critico filtra NO SERVIDOR e mostra o total do recorte, não o da página', async () => {
    renderEm('/admin/customers?health=critico');

    // Sem score carregado para HELIOMAR, o filtro em memória o esconderia — o servidor já filtrou.
    expect(await screen.findByText('JOSE HELIOMAR MARTINS JUNIOR')).toBeTruthy();
    expect(paginasDaBase().at(-1)!.args).toMatchObject({ p_saude: 'critico' });
    expect(screen.getByText(/37 com esses filtros/)).toBeTruthy();
    expect(screen.queryByText(/páginas carregadas até agora/i)).toBeNull();
  });

  it('?health desconhecido vira "todos" (não vai ao servidor, que recusaria com 22023)', async () => {
    renderEm('/admin/customers?health=otimo');
    await screen.findByText('WALTER JOSE NOGUEIRA');

    expect(paginasDaBase().at(-1)!.args?.p_saude).toBeUndefined();
  });

  it('carteira: ordena em memória (seletor de ordem presente) e sem RPC da base', async () => {
    h.modo = 'carteira';
    renderEm('/admin/customers');
    await screen.findByText('WALTER JOSE NOGUEIRA');

    // Onda 1: a vendedora também prioriza — a carteira inteira está em memória com os scores.
    expect(screen.getByRole('button', { name: /Ordenar lista/i })).toBeTruthy();
    expect(paginasDaBase()).toHaveLength(0);
  });
});

describe('AdminCustomers — carteira priorizada (onda 1)', () => {
  const ANA = perfil('aaaaaaaa-0000-4000-8000-000000000001', 'ANA MOVEIS');
  const BRUNO = perfil('bbbbbbbb-0000-4000-8000-000000000002', 'BRUNO MARCENARIA');
  const CARLA = perfil('cccccccc-0000-4000-8000-000000000003', 'CARLA ESQUADRIAS');
  const linha = (user_id: string, priority_score: number | null, sales_history_status = 'ativo') => ({
    customer_user_id: user_id, priority_score, sales_history_status, health_class: 'atencao', health_score: 50,
  });
  const nomesNaTabela = () =>
    screen.getAllByRole('row').slice(1).map((r) => r.querySelector('td span.truncate')?.textContent);

  it('padrão "Priorizar contatos": prioridade DESC, sem prioridade no fim', async () => {
    h.modo = 'carteira';
    h.carteira = [ANA, BRUNO, CARLA];
    h.scores = [linha(ANA.user_id, 10), linha(BRUNO.user_id, 90), linha(CARLA.user_id, 70, 'sem_historico')];
    renderEm('/admin/customers');
    await waitFor(() => expect(nomesNaTabela()).toEqual(['BRUNO MARCENARIA', 'ANA MOVEIS', 'CARLA ESQUADRIAS']));
  });

  it('?ordem=nome: A–Z', async () => {
    h.modo = 'carteira';
    h.carteira = [BRUNO, CARLA, ANA];
    h.scores = [linha(ANA.user_id, 10), linha(BRUNO.user_id, 90)];
    renderEm('/admin/customers?ordem=nome');
    await screen.findByText('BRUNO MARCENARIA');
    await waitFor(() => expect(screen.getAllByText(/Atenção/).length).toBeGreaterThan(0));
    expect(nomesNaTabela()).toEqual(['ANA MOVEIS', 'BRUNO MARCENARIA', 'CARLA ESQUADRIAS']);
  });
});

describe('AdminCustomers — deep link fora das páginas carregadas', () => {
  it('lê o profile por id e abre a ficha', async () => {
    h.alvoPorId = HELIOMAR;
    renderEm(`/admin/customers/${HELIOMAR.user_id}`);

    expect(await screen.findByText('ficha: JOSE HELIOMAR MARTINS JUNIOR')).toBeTruthy();
    const porId = queriesDeProfiles().find((c) => tem(c.ops, 'maybeSingle'))!;
    expect(porId.ops).toContainEqual(['eq', ['user_id', HELIOMAR.user_id]]);
    expect(porId.ops).toContainEqual(['eq', ['is_employee', false]]);
  });

  it('cliente da 1ª página abre pela lista mesmo se a leitura por id não achar', async () => {
    // A frio, a leitura por id corre EM PARALELO com a 1ª página (serializar atrasaria todo
    // deep link fora dela). Quem achar primeiro vale; aqui só a lista acha.
    h.alvoPorId = null;
    renderEm(`/admin/customers/${WALTER.user_id}`);

    expect(await screen.findByText('ficha: WALTER JOSE NOGUEIRA')).toBeTruthy();
    expect(screen.queryByText('Cliente não encontrado')).toBeNull();
  });

  it('id inexistente/invisível: estado explícito, não a lista', async () => {
    renderEm('/admin/customers/00000000-0000-0000-0000-000000000000');

    expect(await screen.findByText('Cliente não encontrado')).toBeTruthy();
    expect(screen.queryByText('WALTER JOSE NOGUEIRA')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Voltar para a lista/i }));
    expect(await screen.findByText('WALTER JOSE NOGUEIRA')).toBeTruthy();
  });

  it('carteira: id fora da carteira NÃO é lido por id (sem vazamento) e avisa', async () => {
    h.modo = 'carteira';
    h.alvoPorId = HELIOMAR; // se a tela lesse por id, "acharia" — e vazaria
    renderEm(`/admin/customers/${HELIOMAR.user_id}`);

    expect(await screen.findByText('Cliente fora da sua carteira')).toBeTruthy();
    await waitFor(() => {
      expect(queriesDeProfiles().some((c) => tem(c.ops, 'maybeSingle'))).toBe(false);
    });
    expect(screen.queryByText(/ficha:/)).toBeNull();
  });
});

describe('useClientesScope — contrato do deep link', () => {
  // Na PÁGINA a corrida é mascarada (lista carregando → skeleton antes do deep link); o contrato
  // é do scope, que não pode depender da ordem de render de quem o consome.
  it('leitura por id vazia ANTES da 1ª página: "carregando", nunca "nao_encontrado"', async () => {
    h.atrasarBase = true;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
    );
    const { result } = renderHook(() => useClientesScope({ customerIdAlvo: WALTER.user_id }), { wrapper });

    await waitFor(() => {
      expect(queriesDeProfiles().some((c) => tem(c.ops, 'maybeSingle'))).toBe(true);
      expect(h.liberarBase).not.toBeNull();
    });
    await new Promise((r) => setTimeout(r, 20)); // a leitura por id (null) já assentou
    expect(result.current.clienteAlvo.estado, 'afirmou ausência sem a lista ter respondido').toBe('carregando');

    h.liberarBase!();
    await waitFor(() => { expect(result.current.clienteAlvo.estado).toBe('encontrado'); });
  });
});
