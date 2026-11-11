import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Plano v8, C14 — SHELL-BADGES-ERRO-ZERO. Os 4 badges da sidebar faziam `return count ?? 0`:
 * a query ficava `success` com 0 e o shell (que só desenha > 0) sumia com o badge, então
 * "não consegui contar" chegava como "nada pendente". Sem o `throw`, a face "?" do
 * <BadgeIndisponivel> é inalcançável — por isso o teste afirma o estado da QUERY e, no fim,
 * a face que o shell desenha.
 */

type Resposta = { data: unknown; error: { message: string } | null; count: number | null };
let resposta: Resposta = { data: null, error: null, count: 0 };

function builder() {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in']) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown) => Promise.resolve(resposta).then(ok);
  return q;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => builder() } }));

import {
  useAumentosAtivosBadge,
  useNegociacaoNovasBadge,
  useNotificacoesPendentesBadge,
  usePedidosPendentesBadge,
} from '../useContagensDoShell';
import { faceDoBadge, primitivosDoBadge } from '../badge-de-contagem';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const HOOKS = [
  ['pedidos pendentes', usePedidosPendentesBadge],
  ['aumentos ativos', useAumentosAtivosBadge],
  ['negociação paralela', useNegociacaoNovasBadge],
  ['notificações pendentes', useNotificacoesPendentesBadge],
] as const;

beforeEach(() => {
  resposta = { data: null, error: null, count: 0 };
});

describe.each(HOOKS)('badge de %s — o erro precisa chegar ao shell', (_nome, useBadge) => {
  it('CONTROLE: leitura boa → success com a contagem e face "numero"', async () => {
    resposta = { data: null, error: null, count: 4 };
    const { result } = renderHook(() => useBadge(true), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toBe(4);
    expect(faceDoBadge(result.current)).toEqual({ tipo: 'numero', valor: 4 });
  });

  it('erro do PostgREST → query em erro e face "indisponivel" (não 0 escondido)', async () => {
    resposta = { data: null, error: { message: 'permission denied' }, count: 0 };
    const { result } = renderHook(() => useBadge(true), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(faceDoBadge(result.current).tipo).toBe('indisponivel');
  });

  it('count ausente sem erro → também é erro (ausente ≠ zero)', async () => {
    resposta = { data: null, error: null, count: null };
    const { result } = renderHook(() => useBadge(true), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('error'));
  });
});

describe('primitivosDoBadge — o que o item da nav recebe', () => {
  it('numero → só o valor', () => {
    expect(primitivosDoBadge({ tipo: 'numero', valor: 3 }, 'x')).toEqual({ valor: 3, indisponivel: undefined });
  });
  it('oculto → nada', () => {
    expect(primitivosDoBadge({ tipo: 'oculto' }, 'x')).toEqual({ valor: undefined, indisponivel: undefined });
  });
  it('indisponivel → só o motivo, com a última leitura', () => {
    const r = primitivosDoBadge({ tipo: 'indisponivel', estado: 'erro', ultimo: 7 }, 'os aumentos ativos');
    expect(r.valor).toBeUndefined();
    expect(r.indisponivel).toContain('os aumentos ativos');
    expect(r.indisponivel).toContain('7');
  });
});
