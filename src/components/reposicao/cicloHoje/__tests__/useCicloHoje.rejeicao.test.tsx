import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PedidoItem } from '@/types/reposicao';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() } },
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
import { logAudit } from '@/lib/reposicao';
import { useCicloHoje } from '../useCicloHoje';

const mockedRpc = vi.mocked(supabase.rpc);
const mockedFrom = vi.mocked(supabase.from);
/** Status ATUAL no banco (o helper relê antes de decidir). */
let statusNoBanco: Record<number, string> = {};
let updates = 0;
function builder() {
  const b = {
    select: () => b,
    in: (_c: string, ids: number[]) => Promise.resolve({ data: ids.filter((id) => id in statusNoBanco).map((id) => ({ id, status: statusNoBanco[id] })), error: null }),
    update: () => { updates += 1; return b; },
    eq: () => b,
  };
  return b;
}

function item(id: number, status: string, extra: Partial<PedidoItem> = {}): PedidoItem {
  return {
    id, status, fornecedor_nome: 'ACME', grupo_codigo: 'G1', num_skus: 2, valor_total: 100,
    pedido_anterior_valor: null, aprovado_em: null, cancelado_em: null, horario_disparo_real: null,
    ...extra,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function montar(filteredItems: PedidoItem[]) {
  return renderHook(
    () => useCicloHoje({ user: { id: 'u1', email: 'lucas@x.com' }, reviewMode: true, filteredItems, setFilters: vi.fn() }),
    { wrapper },
  );
}

beforeEach(() => {
  mockedRpc.mockReset();
  mockedFrom.mockReset().mockImplementation(builder as never);
  statusNoBanco = {}; updates = 0;
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.warning).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(logAudit).mockClear();
});

describe('useCicloHoje.runBatch("reject") — guard de status na fronteira', () => {
  it('"selecionar tudo" + rejeitar: só o pendente vai à RPC; disparado e auto-aprovado são PULADOS (status RELIDO do banco) e o resumo diz isso', async () => {
    statusNoBanco = { 1: 'pendente_aprovacao', 2: 'disparado', 3: 'aprovado_aguardando_disparo' };
    mockedRpc.mockResolvedValue({ data: { status: 'ok' }, error: null } as never);
    const itens = [
      item(1, 'pendente_aprovacao'),
      item(2, 'disparado', { aprovado_em: '2026-09-05T09:00:00Z', horario_disparo_real: '2026-09-05T09:05:00Z' }),
      item(3, 'aprovado_aguardando_disparo', { aprovado_em: '2026-09-05T09:00:00Z' }),
    ];
    const { result } = montar(itens);
    act(() => result.current.toggleAll());
    expect(result.current.selected.size).toBe(3);

    await act(async () => { await result.current.runBatch('reject'); });

    expect(mockedRpc.mock.calls.map((c) => (c[1] as { p_pedido_id: number }).p_pedido_id)).toEqual([1]);
    expect(mockedRpc).toHaveBeenCalledWith('cancelar_pedido_sugerido', expect.objectContaining({
      p_usuario: 'lucas@x.com', p_justificativa: expect.stringContaining('lote'),
    }));
    // nunca UPDATE cru na tabela (a leitura do status é permitida)
    expect(updates).toBe(0);
    // o resumo NÃO pode dizer sucesso pleno: 2 pulados, com o status de cada um
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const resumo = vi.mocked(toast.warning).mock.calls[0][0] as string;
    expect(resumo).toMatch(/1 rejeitado/);
    expect(resumo).toMatch(/2 pulado/);
    expect(resumo).toMatch(/disparado/);
    // auditoria carrega a partição COM os motivos
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'Rejeição em lote',
      metadata: expect.objectContaining({ rejeitados: [1], pulados: [expect.objectContaining({ id: 2, status: 'disparado' }), expect.objectContaining({ id: 3 })] }),
    }));
    // só o rejeitado sai da seleção: os pulados ficam marcados para o operador agir
    expect([...result.current.selected].sort()).toEqual([2, 3]);
  });

  it('todos canceláveis e RPC ok → toast de sucesso com a contagem real (e a seleção zera)', async () => {
    statusNoBanco = { 1: 'pendente_aprovacao', 2: 'bloqueado_guardrail' };
    mockedRpc.mockResolvedValue({ data: { status: 'ok' }, error: null } as never);
    const { result } = montar([item(1, 'pendente_aprovacao'), item(2, 'bloqueado_guardrail')]);
    act(() => result.current.toggleAll());
    await act(async () => { await result.current.runBatch('reject'); });
    expect(toast.success).toHaveBeenCalledWith('2 pedido(s) rejeitado(s)');
    expect(toast.warning).not.toHaveBeenCalled();
    expect(result.current.selected.size).toBe(0);
  });

  it('a RPC recusando um (guard do servidor) → toast de ERRO com "1 com falha" e auditoria com o motivo', async () => {
    statusNoBanco = { 1: 'pendente_aprovacao', 2: 'pendente_aprovacao' };
    mockedRpc
      .mockResolvedValueOnce({ data: { error: 'pedido já foi disparado em 2026-09-05' }, error: null } as never)
      .mockResolvedValueOnce({ data: { status: 'ok' }, error: null } as never);
    const { result } = montar([item(1, 'pendente_aprovacao'), item(2, 'pendente_aprovacao')]);
    act(() => result.current.toggleAll());
    await act(async () => { await result.current.runBatch('reject'); });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toMatch(/1 com falha/);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.stringMatching(/Parcial/),
      metadata: expect.objectContaining({ falhas: [{ id: 1, motivo: 'pedido já foi disparado em 2026-09-05' }] }),
    }));
  });

  it('id selecionado que saiu da lista filtrada é decidido pelo status do BANCO, não pelo que o browser mostra', async () => {
    statusNoBanco = { 1: 'pendente_aprovacao', 2: 'disparado' };
    mockedRpc.mockResolvedValue({ data: { status: 'ok' }, error: null } as never);
    const { result, rerender } = renderHook(
      ({ itens }: { itens: PedidoItem[] }) =>
        useCicloHoje({ user: { id: 'u1', email: 'lucas@x.com' }, reviewMode: true, filteredItems: itens, setFilters: vi.fn() }),
      { wrapper, initialProps: { itens: [item(1, 'pendente_aprovacao'), item(2, 'pendente_aprovacao')] } },
    );
    act(() => result.current.toggleAll());
    rerender({ itens: [item(1, 'pendente_aprovacao')] }); // o 2 saiu do filtro, mas segue em `selected`
    await act(async () => { await result.current.runBatch('reject'); });
    expect(mockedRpc).toHaveBeenCalledTimes(1);
    expect(mockedRpc).toHaveBeenCalledWith('cancelar_pedido_sugerido', expect.objectContaining({ p_pedido_id: 1 }));
  });
});
