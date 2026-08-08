import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guard — o mapa do catalisador precisa DIZER quando degradou por falha.
 *
 * No `useCatalisadorLinksMap`, query em erro vira `byKey` vazio e o hook nem retorna o estado:
 * o selo da venda assistida degrada a "sob consulta" sem nada indicar que foi por FALHA de
 * leitura. Como fallback conservador o vazio é aceitável (nunca inventar vínculo) — mas o hook
 * tem de EXPOR `isError` para a UI poder diferenciar "não há casamento confirmado" de "não
 * consegui ler os casamentos".
 */

let falharLinks = false;

const ERRO_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };

const LINKS = [{ catalisador_codigo_norm: 'CAT-100', account: 'oben', omie_codigo_produto: 111 }];

function resposta(table: string): unknown {
  if (table === 'kb_catalisador_links') {
    if (falharLinks) return { data: null, error: ERRO_TIMEOUT };
    return { data: LINKS, error: null };
  }
  return { data: [], error: null };
}

function chain(table: string): unknown {
  const c: Record<string, unknown> = {};
  for (const m of [
    'select', 'eq', 'gte', 'lt', 'lte', 'gt', 'is', 'not', 'in', 'order', 'limit',
    'range', 'or', 'neq', 'filter', 'single', 'maybeSingle', 'contains',
  ]) c[m] = () => c;
  c.then = (resolve: (v: unknown) => void) => resolve(resposta(table));
  return c;
}

vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: (t: string) => chain(t) } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }));

import { useCatalisadorLinksMap } from '../useCatalisadorLink';

const wrapper = ({ children }: { children: ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

beforeEach(() => {
  falharLinks = false;
  vi.clearAllMocks();
});

describe('useCatalisadorLinksMap — falha de leitura não é silenciosa', () => {
  it('DETECTOR: caminho feliz popula o mapa e isError é false', async () => {
    const { result } = renderHook(() => useCatalisadorLinksMap(), { wrapper });

    await waitFor(() => { expect(result.current.isLoading).toBe(false); });
    expect(result.current.byKey.size).toBe(1);
    expect([...result.current.byKey.values()]).toEqual([[111]]);
    expect(result.current.isError).toBe(false);
  });

  it('sob falha: byKey vazio (fallback conservador) MAS isError exposto = true', async () => {
    falharLinks = true;

    const { result } = renderHook(() => useCatalisadorLinksMap(), { wrapper });

    await waitFor(() => { expect(result.current.isLoading).toBe(false); });
    // O vazio continua correto (nunca inventar vínculo)…
    expect(result.current.byKey.size).toBe(0);
    // …mas a degradação tem de ser DECLARADA, senão a UI não distingue
    // "sem casamento confirmado" de "não consegui ler os casamentos".
    expect(
      result.current.isError,
      'o hook engoliu a falha: a UI não tem como saber que degradou por erro',
    ).toBe(true);
  });
});
