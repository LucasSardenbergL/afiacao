import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * QA 8.3 (2026-11-08, 375×812): em Gerir pedidos o detalhe do pedido era só estado da página —
 * o "voltar" do celular mudava a URL e o modal ficava aberto. Agora o "aberto" mora em `?id=N`:
 * abrir por clique EMPURRA a entrada, voltar a tira e fecha; deep link de fora (`?id=`/`?pedido=`)
 * continua abrindo; X/Esc fecha sem deixar entrada morta e sem sair da tela.
 *
 * A página roda de verdade (queries do componente); só o supabase é mockado. O "voltar" é o
 * `navigate(-1)` do próprio router — o mesmo POP que o popstate do navegador produz.
 */
type Resposta = { data: unknown; error: { message: string } | null };

let pedidosDoCiclo: unknown[] = [];

const pedido = (over: Record<string, unknown> = {}) => ({
  id: 41, empresa: 'colacor_sc', data_ciclo: '2026-11-08', fornecedor_nome: 'Sayerlack',
  fornecedor_id: 9, status: 'pendente_aprovacao', valor_total: 1234.5, itens_count: 3,
  status_envio_portal: null, criado_em: '2026-11-08T09:00:00Z', ...over,
});

function resposta(tabela: string, colunas: string[]): Resposta {
  if (tabela === 'pedido_compra_sugerido' && colunas.some((c) => c.startsWith('status.eq.falha_envio'))) {
    return { data: [], error: null };
  }
  if (tabela === 'pedido_compra_sugerido' && colunas.includes('data_ciclo')) {
    return { data: pedidosDoCiclo, error: null };
  }
  return { data: [], error: null };
}

function chain(tabela: string): unknown {
  const colunas: string[] = [];
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
    'upsert', 'insert', 'update', 'delete',
  ]) {
    c[m] = (arg?: unknown) => {
      if (typeof arg === 'string') colunas.push(arg);
      return c;
    };
  }
  c.then = (resolve: (v: Resposta) => void) => resolve(resposta(tabela, colunas));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    channel: () => {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel: () => Promise.resolve('ok'),
  },
}));
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'master-1' };
  return {
    useAuth: () => ({ user, isMaster: true, isGestorComercial: false, isStaff: true, loading: false }),
  };
});
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn(), captureException: vi.fn() }));

import AdminReposicaoPedidos from '../AdminReposicaoPedidos';

const ROTA = '/admin/reposicao/pedidos';
const TITULO = /Pedido #41 — Sayerlack/;

/** Expõe a URL atual e o `navigate` do router — o "voltar" do teste. */
let navegar: NavigateFunction;
function Sonda() {
  const loc = useLocation();
  navegar = useNavigate();
  return <output data-testid="url">{loc.pathname + loc.search}</output>;
}

function renderPagina(entradas: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={entradas} initialIndex={entradas.length - 1}>
        <AdminReposicaoPedidos />
        <Sonda />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(ui());
}

/**
 * Histórico REAL do jsdom: `history.back()` é ASSÍNCRONO (como no navegador) — a única forma de
 * abrir a janela entre o navigate(-1) e o popstate. No MemoryRouter o go(-1) é síncrono e a trava
 * do duplo Esc fica inalcançável (falsificado: sabotá-la deixava a suíte verde).
 */
function renderPaginaHistoricoReal(entradas: string[]) {
  window.history.replaceState(null, '', entradas[0]);
  for (const e of entradas.slice(1)) window.history.pushState(null, '', e);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AdminReposicaoPedidos />
        <Sonda />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

const url = () => screen.getByTestId('url').textContent;
const modalAberto = () => screen.queryByRole('dialog', { name: TITULO }) !== null;

async function abrirPorClique() {
  const botoes = await screen.findAllByRole('button', { name: /Detalhes/ });
  fireEvent.click(botoes[0]);
  expect(await screen.findByRole('dialog', { name: TITULO })).toBeTruthy();
}

beforeEach(() => {
  pedidosDoCiclo = [pedido()];
});

describe('Gerir pedidos — o "voltar" fecha o detalhe aberto', () => {
  it('clique abre e EMPURRA ?id=; voltar fecha o modal e fica na tela', async () => {
    renderPagina([ROTA]);
    await abrirPorClique();
    expect(url()).toBe(`${ROTA}?id=41`);

    act(() => navegar(-1));

    await waitFor(() => expect(modalAberto()).toBe(false));
    expect(url()).toBe(ROTA);
    // não reabre sozinho depois que a URL assentou
    await new Promise((r) => setTimeout(r, 50));
    expect(modalAberto()).toBe(false);
  });

  it('Esc após o clique desfaz o push: voltar de novo sai da tela (sem entrada morta)', async () => {
    renderPaginaHistoricoReal(['/inicio', ROTA]);
    await abrirPorClique();
    // O jsdom calcula os dois go(-1) a partir do MESMO índice e os funde num só — a URL não
    // mostraria o 2º passo. Conta-se a CHAMADA (no navegador cada uma é um passo de verdade).
    const go = vi.spyOn(window.history, 'go');

    // duplo Esc antes do popstate não pode virar DOIS passos para trás
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    await waitFor(() => expect(modalAberto()).toBe(false));
    expect(url()).toBe(ROTA);
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(-1);
    go.mockRestore();

    act(() => navegar(-1));
    await waitFor(() => expect(url()).toBe('/inicio'));
  });
});

describe('Gerir pedidos — deep link cross-ciclo continua abrindo', () => {
  it.each(['id', 'pedido'])('?%s=41 abre o detalhe', async (param) => {
    renderPagina([`${ROTA}?${param}=41`]);
    expect(await screen.findByRole('dialog', { name: TITULO })).toBeTruthy();
  });

  it('deep link de fora + Esc: fecha, limpa o ?id por replace e NÃO sai da tela', async () => {
    renderPagina(['/inicio', `${ROTA}?id=41`]);
    expect(await screen.findByRole('dialog', { name: TITULO })).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    await waitFor(() => expect(modalAberto()).toBe(false));
    expect(url()).toBe(ROTA);
    // replace: o "voltar" seguinte vai para a tela anterior, não para o ?id de novo
    act(() => navegar(-1));
    await waitFor(() => expect(url()).toBe('/inicio'));
  });

  it('deep link de fora + voltar: fecha o detalhe (a página sai junto da URL)', async () => {
    renderPagina([ROTA, `${ROTA}?id=41`]);
    expect(await screen.findByRole('dialog', { name: TITULO })).toBeTruthy();

    act(() => navegar(-1));

    await waitFor(() => expect(modalAberto()).toBe(false));
    expect(url()).toBe(ROTA);
  });
});
