// Leitor 2 do porte Mini (`docs/historico/tint-purge-staging-io.md`): o badge da sidebar pola
// `tint_sync_errors` a cada 5 min em toda aba de staff. Com embed `tint_sync_runs!inner(...)`
// filtrado, o plano GENÉRICO do PostgREST lia a tabela inteira (~110 MB) por poll. Trava a forma:
// erros por `.in('sync_run_id', <runs da janela>)`, sem embed, e nada lido sem run na janela.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

type Chamada = { tabela: string; metodo: string; args: unknown[] };
const chamadas: Chamada[] = [];
let runsDaJanela: { id: string; errors: number | null }[] = [];
const ULTIMO = { started_at: '2026-10-31T12:00:00+00:00' };

vi.mock('@/integrations/supabase/client', () => {
  const cadeia = (tabela: string) => {
    const metodos = new Set<string>();
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'gte', 'in', 'order', 'limit', 'range', 'maybeSingle']) {
      c[m] = (...args: unknown[]) => { metodos.add(m); chamadas.push({ tabela, metodo: m, args }); return c; };
    }
    c.then = (ok: (v: unknown) => void) => {
      if (tabela === 'tint_sync_runs') {
        ok(metodos.has('maybeSingle') ? { data: ULTIMO, error: null } : { data: runsDaJanela, error: null });
      } else {
        ok({ data: [], error: null });
      }
    };
    return c;
  };
  return { supabase: { from: (t: string) => cadeia(t) } };
});

import { useFormulasRejeitadas } from '../useTintAlertas';

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useFormulasRejeitadas(), { wrapper });
}

const daTabela = (t: string) => chamadas.filter((c) => c.tabela === t);

beforeEach(() => {
  chamadas.length = 0;
});

describe('useTintAlertas — erros lidos pelos runs da janela', () => {
  it('filtra tint_sync_errors por sync_run_id IN (ids dos runs), sem embed de tint_sync_runs', async () => {
    runsDaJanela = [{ id: 'run-b', errors: 2 }, { id: 'run-a', errors: 1 }];
    const { result } = setup();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const erros = daTabela('tint_sync_errors');
    expect(erros.find((c) => c.metodo === 'in')?.args).toEqual(['sync_run_id', ['run-b', 'run-a']]);
    const colunas = String(erros.find((c) => c.metodo === 'select')?.args[0]);
    expect(colunas).not.toContain('tint_sync_runs');
    expect(erros.some((c) => c.metodo === 'eq' || c.metodo === 'gte')).toBe(false);
    expect(result.current.data?.rejeicoesNaJanela).toBe(3);
  });

  it('sem run na janela não consulta tint_sync_errors (`.in()` vazio não é filtro)', async () => {
    runsDaJanela = [];
    const { result } = setup();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(daTabela('tint_sync_errors')).toEqual([]);
    expect(result.current.data?.cores).toEqual([]);
    expect(result.current.data?.rejeicoesNaJanela).toBe(0);
  });
});
