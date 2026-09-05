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
  mockedFrom.mockReset();
  vi.mocked(toast.success).mockReset();
  vi.mocked(toast.warning).mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(logAudit).mockClear();
});

describe('useCicloHoje.runBatch("reject") — guard de status na fronteira', () => {
  it('"selecionar tudo" + rejeitar: só os canceláveis vão à RPC; o disparado é PULADO e o resumo diz isso (não "3 rejeitados")', async () => {
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

    expect(mockedRpc.mock.calls.map((c) => (c[1] as { p_pedido_id: number }).p_pedido_id)).toEqual([1, 3]);
    expect(mockedRpc).toHaveBeenCalledWith('cancelar_pedido_sugerido', expect.objectContaining({
      p_usuario: 'lucas@x.com', p_justificativa: expect.stringContaining('lote'),
    }));
    // nunca UPDATE cru na tabela
    expect(mockedFrom).not.toHaveBeenCalled();
    // o resumo NÃO pode dizer sucesso pleno: 1 pulado
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const resumo = vi.mocked(toast.warning).mock.calls[0][0] as string;
    expect(resumo).toMatch(/2 rejeitado/);
    expect(resumo).toMatch(/1 pulado/);
    // auditoria carrega a partição
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'Rejeição em lote',
      metadata: expect.objectContaining({ rejeitados: [1, 3], pulados: [2] }),
    }));
    // seleção limpa após o lote
    expect(result.current.selected.size).toBe(0);
  });

  it('todos canceláveis e RPC ok → toast de sucesso com a contagem real', async () => {
    mockedRpc.mockResolvedValue({ data: { status: 'ok' }, error: null } as never);
    const { result } = montar([item(1, 'pendente_aprovacao'), item(2, 'bloqueado_guardrail')]);
    act(() => result.current.toggleAll());
    await act(async () => { await result.current.runBatch('reject'); });
    expect(toast.success).toHaveBeenCalledWith('2 pedido(s) rejeitado(s)');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('a RPC recusando um (guard do servidor) → toast de ERRO com "1 com falha" e auditoria com o motivo', async () => {
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

  it('id selecionado que saiu da lista filtrada NÃO vai à RPC (status desconhecido = não rejeita)', async () => {
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
