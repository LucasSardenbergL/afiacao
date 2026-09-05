import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PedidoSugerido } from '../types';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn(), functions: { invoke: vi.fn() } },
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'lucas@x.com' } }) }));
vi.mock('../aprovar-disparar', () => ({ aprovarEDisparar: vi.fn() }));

import { supabase } from '@/integrations/supabase/client';
import { aprovarEDisparar } from '../aprovar-disparar';
import { useDetalhesModal } from '../useDetalhesModal';

interface Op { table: string; op: 'select' | 'update' | 'disparo'; payload?: unknown; filtros: [string, unknown][]; selectApos?: boolean }
let ops: Op[] = [];
let updateRetornaVazio = false;
const ITEM_BASE = { id: 501, pedido_id: 1, sku_codigo_omie: '123', sku_descricao: 'Tinta X', qtde_final: 10, qtde_sugerida: 10, valor_linha: null as number | null };
let itemFixture: Record<string, unknown> = { ...ITEM_BASE, preco_unitario: null };
const tabelas = (): Record<string, unknown[]> => ({
  omie_condicao_pagamento_catalogo: [{ codigo: '001', descricao: 'À vista', num_parcelas: 1, dias_parcelas: '0' }],
  pedido_compra_item: [itemFixture],
});

function builder(table: string) {
  const op: Op = { table, op: 'select', filtros: [] };
  const b = {
    select: () => { if (op.op === 'update') op.selectApos = true; return b; },
    update: (payload: unknown) => { op.op = 'update'; op.payload = payload; return b; },
    eq: (c: string, v: unknown) => { op.filtros.push([c, v]); return b; },
    is: (c: string, v: unknown) => { op.filtros.push([`is:${c}`, v]); return b; },
    in: () => b,
    order: () => b,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      ops.push(op);
      const out = op.op === 'select'
        ? { data: tabelas()[table] ?? [], error: null }
        : { data: op.selectApos ? (updateRetornaVazio ? [] : [{ id: 501 }]) : null, error: null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}

const pedido = {
  id: 1, empresa: 'OBEN', fornecedor_nome: 'ACME', grupo_codigo: null, data_ciclo: '2026-09-05',
  horario_geracao: null, horario_corte_planejado: null, horario_disparo_real: null, valor_total: 0, num_skus: 1,
  pedido_anterior_valor: null, delta_vs_anterior_perc: null, status: 'pendente_aprovacao', mensagem_bloqueio: null,
  omie_pedido_compra_numero: null, aprovado_em: null, aprovado_por: null, condicao_pagamento_codigo: '001',
  condicao_pagamento_descricao: 'À vista', num_parcelas: 1, dias_parcelas: '0', condicao_origem: null,
  status_envio_portal: null, enviado_portal_em: null, portal_protocolo: null, portal_resposta: null,
  portal_screenshot_url: null, portal_tentativas: null, portal_proximo_retry_em: null, portal_erro: null,
  resposta_canal: null,
} as PedidoSugerido;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const updatesDe = (table: string) => ops.filter((o) => o.table === table && o.op === 'update');

async function montarPronto() {
  const r = renderHook(() => useDetalhesModal({ pedido, open: true, onOpenChange: vi.fn(), onApproved: vi.fn() }), { wrapper });
  await waitFor(() => expect(r.result.current.linhas).toHaveLength(1));
  await waitFor(() => expect(r.result.current.condicaoSelecionada?.codigo).toBe('001'));
  return r;
}

beforeEach(() => {
  ops = []; updateRetornaVazio = false; itemFixture = { ...ITEM_BASE, preco_unitario: null };
  vi.mocked(supabase.from).mockReset().mockImplementation(builder as never);
  vi.mocked(aprovarEDisparar).mockReset().mockImplementation(async () => {
    ops.push({ table: 'edge', op: 'disparo', filtros: [] }); // mesmo log: ordem testável
    return { ok: true, tipo: 'success', mensagem: 'ok' };
  });
});

describe('useDetalhesModal.aprovarMutation — "Aprovar e disparar" não descarta edição SÓ de preço (M-03)', () => {
  it('primeira compra (preço nulo): digitar 25 e aprovar grava o preço no item (com compare-and-set na quantidade) e recalcula o cabeçalho ANTES de disparar', async () => {
    const { result } = await montarPronto();
    expect(result.current.podeEditarPreco).toBe(true); // o fluxo real: preço nulo é o único editável
    act(() => result.current.onEditPreco(501, '25'));
    await act(async () => { await result.current.aprovarMutation.mutateAsync(); });

    const iItem = ops.findIndex((o) => o.table === 'pedido_compra_item' && o.op === 'update');
    const iCab = ops.findIndex((o) => o.table === 'pedido_compra_sugerido' && o.op === 'update');
    const iDisparo = ops.findIndex((o) => o.op === 'disparo');
    expect(iItem, 'a edição só-de-preço foi descartada (era o bug)').toBeGreaterThan(-1);
    expect(iItem).toBeLessThan(iDisparo);
    expect(iCab).toBeLessThan(iDisparo);
    expect(ops[iItem].payload).toEqual(expect.objectContaining({ preco_unitario: 25, valor_linha: 250, qtde_final: 10 }));
    expect(ops[iItem].filtros).toContainEqual(['id', 501]);
    expect(ops[iItem].filtros, 'sem compare-and-set, o preço-só reescreve a quantidade velha').toContainEqual(['qtde_final', 10]);
    expect(ops[iItem].selectApos).toBe(true);
    expect(ops[iCab].payload).toEqual(expect.objectContaining({ valor_total: 250 }));
    expect(aprovarEDisparar).toHaveBeenCalledWith(expect.objectContaining({ pedidoId: 1 }));
  });

  it('edição só de quantidade (preço já conhecido) continua salvando (regressão)', async () => {
    itemFixture = { ...ITEM_BASE, preco_unitario: 20, valor_linha: 200 };
    const { result } = await montarPronto();
    act(() => result.current.onEditQty(501, '12'));
    await act(async () => { await result.current.aprovarMutation.mutateAsync(); });
    expect(updatesDe('pedido_compra_item')[0]?.payload).toEqual(expect.objectContaining({ qtde_final: 12, valor_linha: 240 }));
    expect(aprovarEDisparar).toHaveBeenCalledTimes(1);
  });

  it('sem nenhuma edição: aprova sem gravar nada no item', async () => {
    const { result } = await montarPronto();
    await act(async () => { await result.current.aprovarMutation.mutateAsync(); });
    expect(updatesDe('pedido_compra_item')).toEqual([]);
    expect(aprovarEDisparar).toHaveBeenCalledTimes(1);
  });

  it('preço inválido (0) na edição só-de-preço BLOQUEIA a aprovação (não dispara com custo fabricado)', async () => {
    const { result } = await montarPronto();
    act(() => result.current.onEditPreco(501, '0'));
    await expect(act(async () => { await result.current.aprovarMutation.mutateAsync(); })).rejects.toThrow(/Custo inválido/);
    expect(aprovarEDisparar).not.toHaveBeenCalled();
    expect(updatesDe('pedido_compra_item')).toEqual([]);
  });

  it('compare-and-set não casa (outra aba mudou a quantidade): a aprovação falha com erro visível e NADA dispara', async () => {
    updateRetornaVazio = true;
    const { result } = await montarPronto();
    act(() => result.current.onEditPreco(501, '25'));
    await expect(act(async () => { await result.current.aprovarMutation.mutateAsync(); })).rejects.toThrow(/outra pessoa/);
    expect(aprovarEDisparar).not.toHaveBeenCalled();
    expect(updatesDe('pedido_compra_sugerido')).toEqual([]);
  });
});
