import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';

/**
 * Money-path (idempotência do PV) — defeito 1 do parecer Codex r5 do #4236.
 *
 * Com envio PENDENTE (PV aceito no Omie, resposta perdida), o envelope `committed` sobrevive à
 * recarga. Sem `?customer`, "Restaurar" guarda os itens à espera da seleção do cliente do rascunho
 * e fecha o diálogo. Bug: `draft` segue presente e o carrinho segue vazio → o efeito reabria o
 * diálogo por cima da busca, e o "Descartar mesmo assim" apagava o envelope (2º PV no reenvio).
 *
 * A página roda de VERDADE (useOrderDraft e useUnifiedOrder reais; só supabase/auth mockados).
 */

// Um produto vendável da Oben: o cenário do carrinho NOVO no cliente errado precisa adicionar um item.
const PRODUTO = {
  id: 'p-1', codigo: 'TST-1', descricao: 'Produto Teste Um', unidade: 'UN', valor_unitario: 10, estoque: 5,
  ativo: true, omie_codigo_produto: 9, account: 'oben', is_tintometric: false, tint_type: null, metadata: null, tipo_produto: null,
};
function resposta(table: string): unknown {
  if (table === 'omie_products') return { data: [PRODUTO], error: null, count: 1 };
  return { data: [], error: null, count: 0 };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains', 'returns',
    'upsert', 'insert', 'update', 'delete', 'overlaps', 'textSearch',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: [], error: null }),
    channel: () => {
      const ch: Record<string, unknown> = {};
      ch.on = () => ch;
      ch.subscribe = () => ch;
      return ch;
    },
    removeChannel: () => undefined,
    functions: {
      invoke: (_nome: string, opts?: { body?: { action?: string } }) => Promise.resolve(
        opts?.body?.action === 'listar_clientes'
          ? { data: { clientes: [{ codigo_cliente: 999, razao_social: 'Outra Empresa B', nome_fantasia: 'Outra Empresa B', cnpj_cpf: '11', codigo_vendedor: null }] }, error: null }
          : { data: null, error: null },
      ),
    },
    auth: { getSession: () => Promise.resolve({ data: { session: null }, error: null }) },
  },
}));
// `user` nasce DENTRO da factory (`vi.mock` é içado ⇒ const de fora cai na TDZ) e precisa ser o
// MESMO objeto entre renders — identidade nova a cada chamada trava o teste em loop de render.
vi.mock('@/contexts/AuthContext', () => {
  const user = { id: 'vendedor-1' };
  return { useAuth: () => ({ user, isStaff: true, isMaster: false, loading: false, role: 'employee' }) };
});
vi.mock('@/contexts/ImpersonationContext', () => ({
  useImpersonation: () => ({ isImpersonating: false, effectiveUserId: 'vendedor-1' }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), message: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import UnifiedOrder from '../UnifiedOrder';

const ENVELOPE = { checkoutId: 'chk-1', fingerprint: 'u-1#oben:9:1:5.00', committed: true, customerUserId: 'u-1', origem: null, atendimentoId: null };
const RASCUNHO = {
  scopeKey: 'vendedor-1',
  savedAt: new Date().toISOString(),
  state: { cart: [{ id: 'x' }], customerName: 'Cliente 173', customerCodigoCliente: 173, notes: '', ordemCompra: '', parcelasManuais: null },
};

const montar = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const arvore = (): ReactElement => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/sales/new']}>
        <UnifiedOrder />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(arvore());
};

const TITULO = 'Restaurar pedido em andamento?';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('order_draft:vendedor-1', JSON.stringify(RASCUNHO));
  localStorage.setItem('unified_order_checkout_env', JSON.stringify(ENVELOPE));
  vi.clearAllMocks();
});

describe('UnifiedOrder — restaurar com envio pendente e sem cliente na tela', () => {
  it('CONTROLE: o diálogo é oferecido na entrada (rascunho + carrinho vazio)', async () => {
    montar();
    expect(await screen.findByText(TITULO)).toBeTruthy();
  });

  it('"Restaurar" espera o cliente SEM reabrir o diálogo por cima da busca', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: /Restaurar/ }));
    // Prova de que caiu no ramo "esperar o cliente" (não no aplicar direto).
    expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Selecione o cliente para restaurar', expect.anything());
    // Deixa os efeitos rodarem: o bug reabria o diálogo no ciclo seguinte.
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    await waitFor(() => { expect(screen.queryByText(TITULO)).toBeNull(); });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(screen.queryByText(TITULO), 'o diálogo reabriu com a restauração pendente').toBeNull();
    expect(screen.queryByText('Descartar mesmo assim')).toBeNull();
    // O envelope (proteção contra o 2º PV) continua intacto — INTEIRO, não só o checkoutId.
    expect(JSON.parse(localStorage.getItem('unified_order_checkout_env') ?? 'null')).toEqual(ENVELOPE);
  });

  it('selecionar o cliente ERRADO mantém a espera — o diálogo (e o descarte do envelope) não volta', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: /Restaurar/ }));
    // A pré-busca pelo nome do rascunho lista OUTRO cliente (código 999 ≠ 173); a vendedora o escolhe.
    fireEvent.click(await screen.findByText('Outra Empresa B', {}, { timeout: 3000 }));
    await screen.findByRole('button', { name: 'Trocar cliente' }, { timeout: 3000 });
    await waitFor(() => {
      expect(vi.mocked(toast.info)).toHaveBeenCalledWith('Rascunho não restaurado', expect.anything());
    });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(screen.queryByText(TITULO), 'o diálogo reabriu sobre o cliente errado').toBeNull();
    expect(screen.queryByText('Descartar mesmo assim')).toBeNull();
    expect(JSON.parse(localStorage.getItem('unified_order_checkout_env') ?? 'null')).toEqual(ENVELOPE);
  });

  // Codex r2 do #4271: "Trocar cliente" (a saída que o toast indica) apagava rascunho + envelope e a
  // pendência seguia na memória — selecionar o cliente certo punha o carrinho SEM o checkoutId.
  it('"Trocar cliente" no cliente errado preserva rascunho e envelope (sem pedir confirmação)', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: /Restaurar/ }));
    fireEvent.click(await screen.findByText('Outra Empresa B', {}, { timeout: 3000 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Trocar cliente' }, { timeout: 3000 }));
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    // Sem cliente na tela de novo (a busca volta) e sem o diálogo de "desfazer a ligação".
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Trocar cliente' })).toBeNull(); });
    expect(screen.queryByText('Trocar e limpar carrinho')).toBeNull();
    expect(screen.queryByText(TITULO), 'o diálogo reabriu depois da troca').toBeNull();
    expect(JSON.parse(localStorage.getItem('unified_order_checkout_env') ?? 'null')).toEqual(ENVELOPE);
    expect(JSON.parse(localStorage.getItem('order_draft:vendedor-1') ?? 'null')?.state?.customerCodigoCliente).toBe(173);
  });

  // Codex r2 do #4271: carrinho NOVO no cliente errado, esvaziado → o rascunho de A (em memória)
  // reabria o diálogo sobre B, e "Descartar mesmo assim" apagava o envelope de A.
  it('esvaziar um carrinho novo do cliente errado NÃO reoferece o rascunho do outro', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: /Restaurar/ }));
    fireEvent.click(await screen.findByText('Outra Empresa B', {}, { timeout: 3000 }));
    await screen.findByRole('button', { name: 'Trocar cliente' }, { timeout: 3000 });
    const adicionar = await screen.findByRole('button', { name: /^Adicionar$/ }, { timeout: 3000 });
    await waitFor(() => { expect((adicionar as HTMLButtonElement).disabled).toBe(false); }, { timeout: 3000 });
    fireEvent.click(adicionar);
    // CONTROLE do cenário: o item entrou no carrinho (senão o teste não esvaziaria nada).
    fireEvent.click(await screen.findByRole('button', { name: 'Remover Produto Teste Um' }, { timeout: 3000 }));
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Remover Produto Teste Um' })).toBeNull(); });
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(screen.queryByText(TITULO), 'o rascunho do outro cliente reabriu sobre esta seleção').toBeNull();
    expect(screen.queryByText('Descartar mesmo assim')).toBeNull();
    expect(JSON.parse(localStorage.getItem('unified_order_checkout_env') ?? 'null')).toEqual(ENVELOPE);
  });
});
