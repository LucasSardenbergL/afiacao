// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Revisão do Radar 2026-11-11, item 8 — `radar_meus_retornos` paginada por OFFSET: só lê com a lista aberta, pede de 50
 * em 50 pelo que já tem e para quando leu o total (o hook REAL; o servidor é falso).
 */
const rpc = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (n: string, a: unknown) => rpc(n, a) } }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false, effectiveUserId: null }) }));

import { useRadarMeusRetornos } from '../useRadarMeusRetornos';

const item = (n: number) => ({ cnpj: `1${String(n).padStart(13, '0')}`, razao_social: `L${n}`, nome_fantasia: null, municipio_nome: null,
  uf: 'MG', retorno_tipo: 'conversa', retorno_em: '2026-11-01', atrasado: true, nota: null });

describe('useRadarMeusRetornos', () => {
  it('fechada não lê; aberta pede offset 0, depois 50, e para no total', async () => {
    rpc.mockImplementation((_n: string, a: { p_offset: number; p_limit: number }) =>
      Promise.resolve({ data: { total: 70, itens: Array.from({ length: Math.min(a.p_limit, 70 - a.p_offset) }, (_, i) => item(a.p_offset + i)) }, error: null }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result, rerender } = renderHook(({ aberto }) => useRadarMeusRetornos(aberto), { wrapper, initialProps: { aberto: false } });
    await new Promise((r) => setTimeout(r, 10));
    expect(rpc).not.toHaveBeenCalled();
    rerender({ aberto: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpc).toHaveBeenLastCalledWith('radar_meus_retornos', { p_offset: 0, p_limit: 50 });
    expect(result.current.hasNextPage).toBe(true);
    await act(async () => { await result.current.fetchNextPage(); });
    expect(rpc).toHaveBeenLastCalledWith('radar_meus_retornos', { p_offset: 50, p_limit: 50 });
    await waitFor(() => expect(result.current.data?.pages.flatMap((p) => p.itens)).toHaveLength(70));
    expect(result.current.hasNextPage).toBe(false);
  });
});
