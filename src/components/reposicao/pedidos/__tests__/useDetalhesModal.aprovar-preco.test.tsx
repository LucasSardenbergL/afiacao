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

interface Op { table: string; op: 'select' | 'update'; payload?: unknown; filtros: [string, unknown][] }
let ops: Op[] = [];
const tabelas: Record<string, unknown[]> = {
  omie_condicao_pagamento_catalogo: [{ codigo: '001', descricao: 'À vista', num_parcelas: 1, dias_parcelas: '0' }],
  pedido_compra_item: [{
    id: 501, pedido_id: 1, sku_codigo_omie: '123', sku_descricao: 'Tinta X', qtde_final: 10, qtde_sugerida: 10,
    preco_unitario: 20, valor_linha: 200,
  }],
};

function builder(table: string) {
  const op: Op = { table, op: 'select', filtros: [] };
  const b = {
    select: () => b,
    update: (payload: unknown) => { op.op = 'update'; op.payload = payload; return b; },
    eq: (c: string, v: unknown) => { op.filtros.push([c, v]); return b; },
    in: () => b,
    order: () => b,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      ops.push(op);
      const out = op.op === 'select' ? { data: tabelas[table] ?? [], error: null } : { data: null, error: null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return b;
}

const pedido = {
  id: 1, empresa: 'OBEN', fornecedor_nome: 'ACME', grupo_codigo: null, data_ciclo: '2026-09-05',
  horario_geracao: null, horario_corte_planejado: null, horario_disparo_real: null, valor_total: 200, num_skus: 1,
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
  ops = [];
  vi.mocked(supabase.from).mockReset().mockImplementation(builder as never);
  vi.mocked(aprovarEDisparar).mockReset().mockResolvedValue({ ok: true, tipo: 'success', mensagem: 'ok' });
});

describe('useDetalhesModal.aprovarMutation — "Aprovar e disparar" não descarta edição SÓ de preço (M-03)', () => {
  it('edição só de preço (20→25) é gravada no item e o cabeçalho recalculado ANTES de disparar', async () => {
    const { result } = await montarPronto();
    act(() => result.current.onEditPreco(501, '25'));
    await act(async () => { await result.current.aprovarMutation.mutateAsync(); });

    const up = updatesDe('pedido_compra_item');
    expect(up, 'a edição só-de-preço foi descartada (era o bug: só salvava se `edits` de quantidade não fosse vazio)').toHaveLength(1);
    expect(up[0].payload).toEqual(expect.objectContaining({ preco_unitario: 25, valor_linha: 250, qtde_final: 10 }));
    expect(up[0].filtros).toContainEqual(['id', 501]);
    expect(updatesDe('pedido_compra_sugerido')[0]?.payload).toEqual(expect.objectContaining({ valor_total: 250 }));
    expect(aprovarEDisparar).toHaveBeenCalledWith(expect.objectContaining({ pedidoId: 1 }));
    // ordem: gravou o item ANTES de disparar (o disparo lê preco_unitario do banco)
    expect(ops.findIndex((o) => o.table === 'pedido_compra_item' && o.op === 'update')).toBeGreaterThan(-1);
  });

  it('edição só de quantidade continua salvando (regressão)', async () => {
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
});
