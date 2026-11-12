// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Revisão 2026-11-11, item 6 — com o hook REAL (e o `useHojeBRT` real): a agenda "Hoje" muda de dia. A aba que fica
 * aberta da noite para a manhã, ao voltar a ficar visível, relê `radar_prospectar_hoje` com a chave do dia novo.
 */
const rpc = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (n: string, a?: unknown) => rpc(n, a) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ role: 'master', commercialRole: null }) }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => ({ isImpersonating: false, effectiveUserId: null }) }));

import { useRadarProspectarHoje } from '../useRadarProspectarHoje';

const RESPOSTA = { territorio: [], leads: [] };

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: RESPOSTA, error: null });
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => vi.useRealTimers());

describe('useRadarProspectarHoje — o dia BRT na chave', () => {
  it('virou o dia em BRT e a aba voltou: relê com a chave do dia novo', async () => {
    vi.setSystemTime(new Date('2026-11-13T02:50:00Z')); // 12/11, 23:50 em São Paulo
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useRadarProspectarHoje(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(qc.getQueryCache().findAll({ queryKey: ['radar', 'prospectar-hoje'] }).map((q) => q.queryKey.at(-1)))
      .toEqual(['2026-11-12']);

    vi.setSystemTime(new Date('2026-11-13T10:00:00Z')); // 13/11, 07:00 em São Paulo
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(qc.getQueryCache().findAll({ queryKey: ['radar', 'prospectar-hoje', 'eu', '2026-11-13'] })[0]?.state.status).toBe('success'));
  });

  it('mesma hora, mesmo dia: a volta à aba com dado fresco não relê', async () => {
    vi.setSystemTime(new Date('2026-11-12T15:00:00Z'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useRadarProspectarHoje(true), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 20));
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
