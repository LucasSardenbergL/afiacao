import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ColKey, PedidoItem } from '@/types/reposicao';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), functions: { invoke: vi.fn() } },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/reposicao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reposicao')>()),
  logAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/components/reposicao/pedidos/aprovar-disparar', () => ({ aprovarEDisparar: vi.fn() }));

import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { aprovarEDisparar } from '@/components/reposicao/pedidos/aprovar-disparar';
import { PedidoRow } from '../PedidoRow';

/** Builder mínimo do PostgREST: registra cada operação (tabela, op, payload, filtros) e resolve. */
interface Op { table: string; op: 'select' | 'update'; payload?: unknown; filtros: [string, unknown][] }
let ops: Op[] = [];
let itensDoPedido: unknown[] = [];
let erroSelect: { message: string } | null = null;

function builder(table: string) {
  const op: Op = { table, op: 'select', filtros: [] };
  const b = {
    select: () => b,
    update: (payload: unknown) => { op.op = 'update'; op.payload = payload; return b; },
    eq: (c: string, v: unknown) => { op.filtros.push([c, v]); return b; },
    order: () => b,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      ops.push(op);
      const out = op.op === 'select'
        ? { data: erroSelect ? null : itensDoPedido, error: erroSelect }
        : { data: null, error: null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}

function linha(over: Partial<PedidoItem> = {}): PedidoItem {
  return {
    id: 1, fornecedor_nome: 'ACME', grupo_codigo: 'G1', num_skus: 1, valor_total: 500,
    pedido_anterior_valor: null, // "primeiro pedido" → modo revisão → editor inline visível
    status: 'pendente_aprovacao', aprovado_em: null, cancelado_em: null, horario_disparo_real: null,
    ...over,
  };
}
const cols: Record<ColKey, boolean> = {
  fornecedor: true, grupo: false, skus: false, valor: true, preco: false, confianca: false, status: true, qtdAprovada: true,
};

function montar(row: PedidoItem) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChanged = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <table><tbody>
        <PedidoRow row={row} reviewMode={false} selected={false} onToggle={() => {}} cols={cols}
          user={{ id: 'u1', email: 'lucas@x.com' }} onChanged={onChanged} />
      </tbody></table>
    </QueryClientProvider>,
  );
  return { onChanged };
}
// Os dois botões da célula "qtd aprovada" são, nesta ordem, aprovar (✓) e rejeitar (✕).
const botaoAprovar = () => screen.getAllByRole('button')[0];
const updatesDe = (table: string) => ops.filter((o) => o.table === table && o.op === 'update');
const gravouNumSkus = () =>
  ops.some((o) => o.op === 'update' && !!o.payload && typeof o.payload === 'object' && 'num_skus' in (o.payload as object));

beforeEach(() => {
  ops = []; itensDoPedido = []; erroSelect = null;
  vi.mocked(supabase.from).mockReset().mockImplementation(builder as never);
  vi.mocked(aprovarEDisparar).mockReset().mockResolvedValue({ ok: true, tipo: 'success', mensagem: 'ok' });
  vi.mocked(toast.error).mockReset();
});

describe('PedidoRow (ciclo) — o editor de quantidade edita o ITEM do pedido, nunca num_skus (M-03)', () => {
  it('pedido de 1 SKU: o campo mostra a quantidade do ITEM (40), não a contagem de SKUs (1)', async () => {
    itensDoPedido = [{ id: 501, qtde_final: 40, qtde_sugerida: 40, preco_unitario: 12.5 }];
    montar(linha({ num_skus: 1 }));
    expect(await screen.findByDisplayValue('40')).toBeTruthy();
    expect(screen.queryByDisplayValue('1')).toBeNull();
    const sel = ops.find((o) => o.table === 'pedido_compra_item' && o.op === 'select');
    expect(sel?.filtros).toContainEqual(['pedido_id', 1]);
  });

  it('editar 40→35 e aprovar grava qtde_final/valor_linha no ITEM e valor_total no cabeçalho — NUNCA num_skus — e só então dispara', async () => {
    itensDoPedido = [{ id: 501, qtde_final: 40, qtde_sugerida: 40, preco_unitario: 12.5 }];
    montar(linha({ num_skus: 1 }));
    const input = await screen.findByDisplayValue('40');
    fireEvent.change(input, { target: { value: '35' } });
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(aprovarEDisparar).toHaveBeenCalledTimes(1));

    const [upItem] = updatesDe('pedido_compra_item');
    expect(upItem, 'não gravou o item').toBeTruthy();
    expect(upItem.payload).toEqual({ qtde_final: 35, valor_linha: 437.5, ajustado_humano: true });
    expect(upItem.filtros).toContainEqual(['id', 501]);
    const [upCab] = updatesDe('pedido_compra_sugerido');
    expect(upCab, 'não recalculou o cabeçalho').toBeTruthy();
    expect(upCab.payload).toEqual(expect.objectContaining({ valor_total: 437.5 }));
    expect(upCab.filtros).toContainEqual(['id', 1]);
    expect(gravouNumSkus(), 'gravou num_skus (era o bug: contagem de SKUs ≠ quantidade)').toBe(false);
    expect(aprovarEDisparar).toHaveBeenCalledWith(expect.objectContaining({ pedidoId: 1 }));
  });

  it('quantidade inalterada: aprova sem tocar no item nem no cabeçalho', async () => {
    itensDoPedido = [{ id: 501, qtde_final: 40, qtde_sugerida: 40, preco_unitario: 12.5 }];
    montar(linha({ num_skus: 1 }));
    await screen.findByDisplayValue('40');
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(aprovarEDisparar).toHaveBeenCalledTimes(1));
    expect(updatesDe('pedido_compra_item')).toEqual([]);
    expect(updatesDe('pedido_compra_sugerido')).toEqual([]);
    expect(gravouNumSkus()).toBe(false);
  });

  it('pedido multi-SKU: SEM editor inline (num_skus não é quantidade), mostra "7 SKUs"; aprovar não grava item nem num_skus', async () => {
    montar(linha({ num_skus: 7 }));
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByText(/7 SKUs/)).toBeTruthy();
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(aprovarEDisparar).toHaveBeenCalledTimes(1));
    expect(ops.filter((o) => o.table === 'pedido_compra_item')).toEqual([]);
    expect(gravouNumSkus()).toBe(false);
  });

  it('quantidade ≤ 0 bloqueia a aprovação (toast de erro), sem gravar nem disparar', async () => {
    itensDoPedido = [{ id: 501, qtde_final: 40, qtde_sugerida: 40, preco_unitario: 12.5 }];
    montar(linha({ num_skus: 1 }));
    const input = await screen.findByDisplayValue('40');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(aprovarEDisparar).not.toHaveBeenCalled();
    expect(updatesDe('pedido_compra_item')).toEqual([]);
    expect(gravouNumSkus()).toBe(false);
  });

  it('item sem preço conhecido: grava valor_linha null (ausente ≠ zero) e NÃO reescreve valor_total', async () => {
    itensDoPedido = [{ id: 501, qtde_final: 40, qtde_sugerida: 40, preco_unitario: null }];
    montar(linha({ num_skus: 1, valor_total: null }));
    const input = await screen.findByDisplayValue('40');
    fireEvent.change(input, { target: { value: '35' } });
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(aprovarEDisparar).toHaveBeenCalledTimes(1));
    expect(updatesDe('pedido_compra_item')[0].payload).toEqual({ qtde_final: 35, valor_linha: null, ajustado_humano: true });
    expect(updatesDe('pedido_compra_sugerido')).toEqual([]);
  });

  it('falha ao carregar o item: o campo fica desabilitado e vazio (sem número fabricado); aprovar segue sem edição', async () => {
    erroSelect = { message: 'boom' };
    montar(linha({ num_skus: 1 }));
    await waitFor(() => expect(ops.some((o) => o.table === 'pedido_compra_item')).toBe(true));
    const input = await screen.findByRole('spinbutton');
    await waitFor(() => expect(input).toBeDisabled());
    expect((input as HTMLInputElement).value).toBe('');
    fireEvent.click(botaoAprovar());
    await waitFor(() => expect(aprovarEDisparar).toHaveBeenCalledTimes(1));
    expect(updatesDe('pedido_compra_item')).toEqual([]);
    expect(gravouNumSkus()).toBe(false);
  });
});
