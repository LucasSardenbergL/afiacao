// Onda D (Clientes): o Cmd-K não busca nem exibe documento/e-mail fora do escopo, não lista staff
// como cliente, não engole erro e não guarda PII em localStorage.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rpc = vi.fn();
const from = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) } }));
let userId: string | null = 'u-farmer';
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isStaff: true, user: userId ? { id: userId } : null }) }));
vi.mock('@/hooks/useDebouncedValue', () => ({ useDebouncedValue: (v: string) => v }));

import {
  CHAVE_RECENTES_LEGADA, chaveRecentes, gravarRecentes, lerRecentes, mapearClientesBusca, paraRecente,
  useGlobalSearch, type SearchResult,
} from '../useGlobalSearch';

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
// tint_formulas / sales_orders: cadeia mínima que resolve vazio
function fromVazio() {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'is', 'or', 'ilike']) q[m] = () => q;
  q.limit = () => Promise.resolve({ data: [], error: null });
  return q;
}

beforeEach(() => {
  rpc.mockReset(); from.mockReset(); from.mockImplementation(fromVazio);
  localStorage.clear(); userId = 'u-farmer';
});

describe('mapearClientesBusca', () => {
  it('fora do escopo não há subtitle, mesmo que a linha traga algo', () => {
    const [r] = mapearClientesBusca([{ user_id: 'c3', name: 'Cliente Tres', razao_social: null, contato_visivel: false, documento: 'doc-vazado', email: 'x@y' }]);
    expect(r.subtitle).toBeUndefined();
    expect(r.path).toBe('/admin/customers/c3/360');
  });
  it('dentro do escopo mostra o documento liberado pelo servidor', () => {
    const [r] = mapearClientesBusca([{ user_id: 'c1', name: 'Cliente Um', razao_social: null, contato_visivel: true, documento: '123', email: null }]);
    expect(r.subtitle).toBe('123');
  });
});

describe('recentes sem PII e por usuário', () => {
  const comDoc: SearchResult = { kind: 'customer', id: 'c1', title: 'Cliente Um', subtitle: '12.345.678/0001-90', path: '/admin/customers/c1/360' };

  it('paraRecente descarta o subtitle', () => {
    expect(paraRecente(comDoc)).toEqual({ kind: 'customer', id: 'c1', title: 'Cliente Um', path: '/admin/customers/c1/360' });
  });
  it('o que vai para o localStorage não contém o documento', () => {
    gravarRecentes('u-farmer', [comDoc]);
    const raw = localStorage.getItem(chaveRecentes('u-farmer')) ?? '';
    expect(raw).toContain('Cliente Um');
    expect(raw).not.toContain('0001-90');
    expect(raw).not.toContain('subtitle');
  });
  it('recentes de um usuário não aparecem para outro', () => {
    gravarRecentes('u-farmer', [comDoc]);
    expect(lerRecentes('u-outro')).toEqual([]);
    expect(lerRecentes('u-farmer').map((r) => r.id)).toEqual(['c1']);
  });
  it('sem usuário não lê nem grava', () => {
    gravarRecentes(null, [comDoc]);
    expect(localStorage.length).toBe(0);
    expect(lerRecentes(null)).toEqual([]);
  });
  it('a chave antiga global (com documento no subtitle) é apagada na leitura', () => {
    localStorage.setItem(CHAVE_RECENTES_LEGADA, JSON.stringify([comDoc]));
    lerRecentes('u-farmer');
    expect(localStorage.getItem(CHAVE_RECENTES_LEGADA)).toBeNull();
  });
  it('re-sanitiza entrada gravada com subtitle', () => {
    localStorage.setItem(chaveRecentes('u-farmer'), JSON.stringify([comDoc]));
    expect(lerRecentes('u-farmer')[0]).not.toHaveProperty('subtitle');
  });
});

describe('useGlobalSearch — clientes pela RPC escopada', () => {
  it('chama buscar_clientes_global e nunca lê profiles direto', async () => {
    rpc.mockResolvedValue({ data: [{ user_id: 'c1', name: 'Cliente Um', razao_social: null, contato_visivel: true, documento: '123', email: null }], error: null });
    const { result } = renderHook(() => useGlobalSearch('Cliente'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.groups.length).toBe(1));
    expect(rpc).toHaveBeenCalledWith('buscar_clientes_global', { p_termo: 'Cliente', p_limite: 5 });
    expect(from).not.toHaveBeenCalledWith('profiles');
    expect(result.current.erros).toEqual([]);
  });
  it('erro da RPC FALA (não vira "nada encontrado")', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied', code: '42501' } });
    const { result } = renderHook(() => useGlobalSearch('Cliente'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.erros).toEqual(['clientes']));
    expect(result.current.hasResults).toBe(false);
  });
});

describe('fonte', () => {
  it('o hook não consulta profiles nem filtra por document/email', () => {
    const src = readFileSync(resolve(__dirname, '../useGlobalSearch.ts'), 'utf8');
    expect(src).not.toMatch(/from\('profiles'\)/);
    expect(src).not.toMatch(/ilikeOr\(\[[^\]]*'document'/);
  });
});
