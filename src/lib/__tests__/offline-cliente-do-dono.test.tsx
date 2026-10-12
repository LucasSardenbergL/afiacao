/**
 * Fronteira HTTP do flush offline: o JWT que ASSINA cada requisição é o do DONO do item.
 *
 * Conferir a sessão antes do handler não basta — o SDK relê a sessão do aparelho a cada
 * requisição, e `confirmUnit` faz três (Codex reproduziu A/B/B). Aqui o SDK é o REAL
 * (`@supabase/supabase-js` + postgrest), com o `fetch` interceptado; só a leitura da sessão
 * (`credencialDaSessao`) é controlada pelo teste.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ANTES de qualquer import: o SDK captura o `fetch` global ao criar o cliente (inclusive o
// singleton, criado no import). Nada deste arquivo pode sair para a rede de verdade.
const { fetchMock } = vi.hoisted(() => {
  const fetchMock = vi.fn(
    async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock };
});

vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));
vi.mock('@/lib/offline-cliente-do-dono', async (original) => ({
  ...(await original<typeof import('@/lib/offline-cliente-do-dono')>()),
  credencialDaSessao: vi.fn(),
}));

import { credencialDaSessao, subDoJwt } from '@/lib/offline-cliente-do-dono';
import { enqueue, getOfflineQueueDepth } from '@/lib/offline-queue';
import { registerAllOfflineHandlers } from '@/lib/offline-handlers';
import { useOfflineFlush, __clearHandlersForTest } from '@/hooks/useOfflineFlush';
import { confirmUnit, type ConfirmUnitVars } from '@/services/recebimento-confirm';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function b64url(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jwt(sub: string): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, role: 'authenticated', exp: 4102444800 })}.assinatura`;
}

const vars: ConfirmUnitVars = {
  nfeId: 'nfe-1',
  itemId: 'item-1',
  userId: A,
  loteNumero: 'L1',
  loteFabricacao: null,
  loteValidade: '2027-01-01',
  metodoLeitura: 'manual',
  newConferida: 1,
  newStatusItem: 'em_conferencia',
  updateNfeStatusToEmConferencia: true, // 3 requisições: insert + 2 updates
};

/** `sub` do Authorization de cada requisição REST interceptada. */
function subsDasRequisicoesRest(): (string | null)[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/rest/v1/'))
    .map(([, init]) => {
      const h = new Headers((init as RequestInit | undefined)?.headers);
      const auth = h.get('Authorization') ?? '';
      return subDoJwt(auth.replace(/^Bearer\s+/i, ''));
    });
}

const credencial = vi.mocked(credencialDaSessao);
let queryClient: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  localStorage.clear();
  __clearHandlersForTest();
  fetchMock.mockClear();
  credencial.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('flush offline assina com o token do DONO', () => {
  it('controle: o singleton (sessão do aparelho) NÃO assina como A — o detector distingue', async () => {
    await confirmUnit(vars);
    const subs = subsDasRequisicoesRest();
    expect(subs).toHaveLength(3);
    expect(subs.every((s) => s === A)).toBe(false);
  });

  it('as 3 requisições do confirmUnit saem com o JWT de A, mesmo com B logado depois da checagem', async () => {
    // 1ª leitura (a do item de A): A. Depois disso o aparelho "vira" B — as requisições do
    // handler NÃO podem reler a sessão.
    credencial
      .mockResolvedValueOnce({ userId: A, accessToken: jwt(A) })
      .mockResolvedValue({ userId: B, accessToken: jwt(B) });
    registerAllOfflineHandlers();
    await enqueue('recebimento.confirm-unit', vars, A);

    renderHook(() => useOfflineFlush(), { wrapper });

    await waitFor(async () => expect(await getOfflineQueueDepth()).toBe(0));
    expect(subsDasRequisicoesRest()).toEqual([A, A, A]);
  });

  it('item de A com B logado: nenhuma requisição sai', async () => {
    credencial.mockResolvedValue({ userId: B, accessToken: jwt(B) });
    registerAllOfflineHandlers();
    await enqueue('recebimento.confirm-unit', vars, A);

    renderHook(() => useOfflineFlush(), { wrapper });

    await waitFor(() => expect(credencial).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(subsDasRequisicoesRest()).toEqual([]);
    expect(await getOfflineQueueDepth()).toBe(1);
  });
});

describe('subDoJwt', () => {
  it('lê o sub do payload; token malformado → null', () => {
    expect(subDoJwt(jwt(A))).toBe(A);
    expect(subDoJwt('nao-e-jwt')).toBeNull();
    expect(subDoJwt('a.%%%.c')).toBeNull();
    expect(subDoJwt(`${b64url({})}.${b64url({ role: 'anon' })}.x`)).toBeNull();
  });
});
