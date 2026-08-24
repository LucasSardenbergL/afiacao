import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock('@/lib/analytics', () => ({
  track: vi.fn(),
}));

import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { useLastVisit, useRegistrarVisitaDashboard } from '../useLastVisit';

const mockedUseAuth = vi.mocked(useAuth);
const mockedFrom = vi.mocked(supabase.from);
const mockedTrack = vi.mocked(track);

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mockedUseAuth.mockReset();
  mockedFrom.mockReset();
  mockedTrack.mockReset();
  localStorage.clear();
});

/**
 * Dublê FIEL ao PostgrestBuilder: o fetch real vive DENTRO de then(), então o
 * builder só emite HTTP quando alguém PUXA a promise. Um `vi.fn()` comum
 * esconderia exatamente o bug que este arquivo precisa pegar (`void builder`
 * monta a query e não manda nada).
 */
function criarInsertPreguicoso(erro: { code: string; message: string } | null = null) {
  const emitidos: Array<Record<string, unknown>> = [];
  let payload: Record<string, unknown> | null = null;
  const insert = vi.fn((p: Record<string, unknown>) => {
    payload = p;
    return builder;
  });
  const builder = {
    insert,
    then(onOk: (r: { error: typeof erro }) => unknown, onErr?: (e: unknown) => unknown) {
      if (payload) emitidos.push(payload);
      return Promise.resolve({ error: erro }).then(onOk, onErr);
    },
  };
  return { builder, emitidos, insert };
}

describe('useLastVisit', () => {
  it('returns null when no user and no localStorage', () => {
    mockedUseAuth.mockReturnValue({ user: null } as ReturnType<typeof useAuth>);
    const { result } = renderHook(() => useLastVisit(), { wrapper });
    expect(result.current.lastVisitIso).toBeNull();
    expect(result.current.minutesSinceLastVisit).toBeNull();
  });

  it('falls back to localStorage when no user', () => {
    const iso = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h atrás
    localStorage.setItem('dashboardLastVisit', iso);
    mockedUseAuth.mockReturnValue({ user: null } as ReturnType<typeof useAuth>);
    const { result } = renderHook(() => useLastVisit(), { wrapper });
    expect(result.current.lastVisitIso).toBe(iso);
    expect(result.current.minutesSinceLastVisit).toBeGreaterThanOrEqual(60);
  });

  it('queries previous visit when user present', async () => {
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-1' },
    } as ReturnType<typeof useAuth>);

    const serverIso = new Date(Date.now() - 120 * 60_000).toISOString();
    const maybeSingle = vi.fn().mockResolvedValue({ data: { visited_at: serverIso } });
    const rangeFn = vi.fn().mockReturnValue({ maybeSingle });
    const orderFn = vi.fn().mockReturnValue({ range: rangeFn });
    const eqFn = vi.fn().mockReturnValue({ order: orderFn });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockedFrom.mockReturnValue({ select: selectFn } as unknown as ReturnType<typeof supabase.from>);

    const { result } = renderHook(() => useLastVisit(), { wrapper });

    await waitFor(() => expect(result.current.lastVisitIso).toBe(serverIso));
    expect(result.current.minutesSinceLastVisit).toBeGreaterThanOrEqual(120);
    expect(mockedFrom).toHaveBeenCalledWith('dashboard_visits');
    expect(eqFn).toHaveBeenCalledWith('user_id', 'user-1');
    expect(rangeFn).toHaveBeenCalledWith(0, 0);
  });

  it('server visit wins over localStorage when both available', async () => {
    const localIso = new Date(Date.now() - 30 * 60_000).toISOString();
    const serverIso = new Date(Date.now() - 180 * 60_000).toISOString();
    localStorage.setItem('dashboardLastVisit', localIso);
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-2' },
    } as ReturnType<typeof useAuth>);

    const maybeSingle = vi.fn().mockResolvedValue({ data: { visited_at: serverIso } });
    const rangeFn = vi.fn().mockReturnValue({ maybeSingle });
    const orderFn = vi.fn().mockReturnValue({ range: rangeFn });
    const eqFn = vi.fn().mockReturnValue({ order: orderFn });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockedFrom.mockReturnValue({ select: selectFn } as unknown as ReturnType<typeof supabase.from>);

    const { result } = renderHook(() => useLastVisit(), { wrapper });
    await waitFor(() => expect(result.current.lastVisitIso).toBe(serverIso));
  });

  it('falls back to localStorage when server returns null', async () => {
    const localIso = new Date(Date.now() - 45 * 60_000).toISOString();
    localStorage.setItem('dashboardLastVisit', localIso);
    mockedUseAuth.mockReturnValue({
      user: { id: 'user-3' },
    } as ReturnType<typeof useAuth>);

    const maybeSingle = vi.fn().mockResolvedValue({ data: null });
    const rangeFn = vi.fn().mockReturnValue({ maybeSingle });
    const orderFn = vi.fn().mockReturnValue({ range: rangeFn });
    const eqFn = vi.fn().mockReturnValue({ order: orderFn });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockedFrom.mockReturnValue({ select: selectFn } as unknown as ReturnType<typeof supabase.from>);

    const { result } = renderHook(() => useLastVisit(), { wrapper });
    // Espera resolver a query (resolve com null), depois cai pro local
    await waitFor(() => expect(result.current.lastVisitIso).toBe(localIso));
  });
  it('le a visita MAIS RECENTE como anterior (a escrita da visita atual so ocorre no unmount)', async () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-9' } } as ReturnType<typeof useAuth>);
    const maybeSingle = vi.fn().mockResolvedValue({ data: null });
    const rangeFn = vi.fn().mockReturnValue({ maybeSingle });
    const orderFn = vi.fn().mockReturnValue({ range: rangeFn });
    const eqFn = vi.fn().mockReturnValue({ order: orderFn });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockedFrom.mockReturnValue({ select: selectFn } as unknown as ReturnType<typeof supabase.from>);

    renderHook(() => useLastVisit(), { wrapper });
    await waitFor(() => expect(rangeFn).toHaveBeenCalled());
    expect(rangeFn).toHaveBeenCalledWith(0, 0);
  });

  it('useLastVisit e SOMENTE leitura — nao escreve visita (ha 3 instancias montadas no dashboard)', () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-10' } } as ReturnType<typeof useAuth>);
    const { insert } = criarInsertPreguicoso();
    const maybeSingle = vi.fn().mockResolvedValue({ data: null });
    const rangeFn = vi.fn().mockReturnValue({ maybeSingle });
    const orderFn = vi.fn().mockReturnValue({ range: rangeFn });
    const eqFn = vi.fn().mockReturnValue({ order: orderFn });
    const selectFn = vi.fn().mockReturnValue({ eq: eqFn });
    mockedFrom.mockReturnValue({ select: selectFn, insert } as unknown as ReturnType<typeof supabase.from>);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const { unmount } = renderHook(() => useLastVisit(), { wrapper });
    relogio.mockReturnValue(agora + 30 * 60_000);
    unmount();
    relogio.mockRestore();

    expect(insert).not.toHaveBeenCalled();
  });
});

describe('useRegistrarVisitaDashboard', () => {
  const contexto = { persona: 'gestao', companySelection: 'all' };

  it('EMITE o insert em dashboard_visits ao desmontar apos 5min (montar o builder nao manda nada)', async () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-11' } } as ReturnType<typeof useAuth>);
    const { builder, emitidos } = criarInsertPreguicoso();
    mockedFrom.mockReturnValue(builder as unknown as ReturnType<typeof supabase.from>);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const { unmount } = renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 6 * 60_000);
    unmount();
    relogio.mockRestore();

    await waitFor(() => expect(emitidos).toHaveLength(1));
    expect(mockedFrom).toHaveBeenCalledWith('dashboard_visits');
    expect(emitidos[0]).toMatchObject({
      user_id: 'user-11',
      session_minutes: 6,
      persona: 'gestao',
      company_selection: 'all',
    });
  });

  it('nao escreve quando a sessao dura menos de 5min (F5 nao anula deltas)', () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-12' } } as ReturnType<typeof useAuth>);
    const { builder, emitidos, insert } = criarInsertPreguicoso();
    mockedFrom.mockReturnValue(builder as unknown as ReturnType<typeof supabase.from>);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const { unmount } = renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 4 * 60_000);
    unmount();
    relogio.mockRestore();

    expect(insert).not.toHaveBeenCalled();
    expect(emitidos).toHaveLength(0);
  });

  it('reporta dashboard.visita_erro quando o banco recusa o insert (falha nao pode ser silenciosa)', async () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-13' } } as ReturnType<typeof useAuth>);
    const { builder } = criarInsertPreguicoso({ code: '42501', message: 'permission denied' });
    mockedFrom.mockReturnValue(builder as unknown as ReturnType<typeof supabase.from>);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const { unmount } = renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 7 * 60_000);
    unmount();
    relogio.mockRestore();

    await waitFor(() =>
      expect(mockedTrack).toHaveBeenCalledWith('dashboard.visita_erro', expect.objectContaining({ code: '42501' })),
    );
  });

  /**
   * O sensor de TENTATIVA. Sem ele o cleanup tem TRES saidas mudas colapsadas em
   * "tabela vazia": sessao curta, sem usuario, e (fora do alcance do hook) aba
   * fechada — nenhuma emitia nada, e so a QUARTA (banco recusa) tinha sinal.
   * Medir `dashboard_visits` vazio era indistinguivel de "ninguem ficou 5min".
   */
  it('emite visita_tentativa com motivo=sessao_curta quando desiste por tempo (o return mudo da :81)', () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-14' } } as ReturnType<typeof useAuth>);
    const { builder, insert } = criarInsertPreguicoso();
    mockedFrom.mockReturnValue(builder as unknown as ReturnType<typeof supabase.from>);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const { unmount } = renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 4 * 60_000);
    unmount();
    relogio.mockRestore();

    expect(insert).not.toHaveBeenCalled();
    expect(mockedTrack).toHaveBeenCalledWith(
      'dashboard.visita_tentativa',
      expect.objectContaining({ motivo: 'sessao_curta', session_minutes: 4 }),
    );
  });

  it('emite visita_tentativa com motivo=sem_usuario quando ficou 5min mas nao ha user (o return mudo da :90)', () => {
    mockedUseAuth.mockReturnValue({ user: null } as unknown as ReturnType<typeof useAuth>);
    const { builder, insert } = criarInsertPreguicoso();
    mockedFrom.mockReturnValue(builder as unknown as ReturnType<typeof supabase.from>);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const { unmount } = renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 8 * 60_000);
    unmount();
    relogio.mockRestore();

    expect(insert).not.toHaveBeenCalled();
    expect(mockedTrack).toHaveBeenCalledWith(
      'dashboard.visita_tentativa',
      expect.objectContaining({ motivo: 'sem_usuario', session_minutes: 8 }),
    );
  });

  it('emite visita_tentativa com motivo=gravou no caminho feliz (o denominador do INSERT)', async () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-15' } } as ReturnType<typeof useAuth>);
    const { builder, emitidos } = criarInsertPreguicoso();
    mockedFrom.mockReturnValue(builder as unknown as ReturnType<typeof supabase.from>);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const { unmount } = renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 6 * 60_000);
    unmount();
    relogio.mockRestore();

    await waitFor(() => expect(emitidos).toHaveLength(1));
    expect(mockedTrack).toHaveBeenCalledWith(
      'dashboard.visita_tentativa',
      expect.objectContaining({ motivo: 'gravou', session_minutes: 6 }),
    );
  });
});
