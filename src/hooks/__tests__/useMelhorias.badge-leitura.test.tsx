import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Plano v7, C11 — a ponta de DADOS do badge de melhorias abertas.
 *
 * `if (error) return 0` deixava a query `success` com 0, e o shell (que só desenha valor > 0)
 * sumia com o badge: "não consegui contar" chegava como "nada aberto". Sem o `throw`, a face
 * "?" do <BadgeIndisponivel> seria inalcançável. Por isso o teste afirma o estado da QUERY.
 */

type Resposta = { data: unknown; error: { message: string } | null; count?: number | null };
let resposta: Resposta = { data: null, error: null, count: 0 };

function builder() {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'in']) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown) => Promise.resolve(resposta).then(ok);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => builder() } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

import { useMelhoriasBadge } from '../useMelhorias';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  resposta = { data: null, error: null, count: 0 };
});

describe('useMelhoriasBadge — o erro precisa chegar ao shell', () => {
  it('CONTROLE: leitura boa → success com a contagem', async () => {
    resposta = { data: null, error: null, count: 2 };
    const { result } = renderHook(() => useMelhoriasBadge(true), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toBe(2);
  });

  it('ERRO no select → a query entra em erro (não success com 0)', async () => {
    resposta = { data: null, error: { message: 'permission denied' }, count: null };
    const { result } = renderHook(() => useMelhoriasBadge(true), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.data).toBeUndefined();
  });
});
