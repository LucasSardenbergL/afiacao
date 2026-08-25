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

vi.mock('@/lib/impersonation/lens-write-guard', () => ({
  isLensActive: vi.fn(() => false),
}));

import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { useLastVisit, useRegistrarVisitaDashboard, useTrackDashboardViewed } from '../useLastVisit';

const mockedUseAuth = vi.mocked(useAuth);
const mockedFrom = vi.mocked(supabase.from);
const mockedTrack = vi.mocked(track);
const mockedIsLensActive = vi.mocked(isLensActive);

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
  mockedIsLensActive.mockReset();
  mockedIsLensActive.mockReturnValue(false);
  vi.unstubAllGlobals();
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

  /**
   * O TIMER. Provado em produção (2026-08-25): o `fetch` com `keepalive:true` do
   * `pagehide` NÃO sobrevive ao unload — mesmo caminho, mesmo token, mesma policy
   * devolvem 201 com a página VIVA e nada quando a aba fecha de verdade. Enquanto
   * a gravação dependesse de COMO o usuário sai, fechar a aba perdia a visita.
   * O timer torna a gravação independente da saída: ao cruzar MIN_SESSION_MS a
   * visita já está no banco.
   */
  it('GRAVA ao cruzar MIN_SESSION_MS sem unmount e sem pagehide — a saída deixou de ser requisito', async () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-timer' } } as ReturnType<typeof useAuth>);
    const { builder, emitidos } = criarInsertPreguicoso();
    mockedFrom.mockReturnValue(builder as unknown as ReturnType<typeof supabase.from>);

    vi.useFakeTimers();
    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });

    relogio.mockReturnValue(agora + 5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(emitidos).toHaveLength(1);
    expect(emitidos[0]).toMatchObject({ user_id: 'user-timer', persona: 'gestao' });

    relogio.mockRestore();
    vi.useRealTimers();
  });

  it('o timer NAO duplica: depois de gravar, o unmount reporta ja_gravado e nao insere de novo', async () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-timer2' } } as ReturnType<typeof useAuth>);
    const { builder, emitidos } = criarInsertPreguicoso();
    mockedFrom.mockReturnValue(builder as unknown as ReturnType<typeof supabase.from>);

    vi.useFakeTimers();
    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const { unmount } = renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });

    relogio.mockReturnValue(agora + 5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(emitidos).toHaveLength(1);

    relogio.mockReturnValue(agora + 9 * 60_000);
    unmount();
    relogio.mockRestore();
    vi.useRealTimers();

    expect(emitidos).toHaveLength(1);
    expect(mockedTrack).toHaveBeenCalledWith(
      'dashboard.visita_tentativa',
      expect.objectContaining({ motivo: 'ja_gravado' })
    );
  });

  it('desmontar ANTES dos 5min cancela o timer — nao grava depois de a tela ter sumido', async () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-timer3' } } as ReturnType<typeof useAuth>);
    const { builder, emitidos, insert } = criarInsertPreguicoso();
    mockedFrom.mockReturnValue(builder as unknown as ReturnType<typeof supabase.from>);

    vi.useFakeTimers();
    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const { unmount } = renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });

    relogio.mockReturnValue(agora + 2 * 60_000);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    unmount();

    // passa MUITO do limiar: se o timer sobrevivesse ao unmount, gravaria aqui
    relogio.mockReturnValue(agora + 30 * 60_000);
    await vi.advanceTimersByTimeAsync(28 * 60_000);
    relogio.mockRestore();
    vi.useRealTimers();

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

/**
 * Leitura da visita anterior. `pendente: true` devolve uma promise que NUNCA
 * resolve — é assim que se reproduz a corrida que deixava
 * `time_since_last_visit_min` nulo em 39 de 46 eventos.
 */
function criarLeituraVisita(iso: string | null, { pendente = false } = {}) {
  const maybeSingle = vi.fn(() =>
    pendente
      ? new Promise(() => {})
      : Promise.resolve({ data: iso ? { visited_at: iso } : null }),
  );
  const selectFn = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      order: vi.fn().mockReturnValue({ range: vi.fn().mockReturnValue({ maybeSingle }) }),
    }),
  });
  return { select: selectFn } as unknown as ReturnType<typeof supabase.from>;
}

describe('useRegistrarVisitaDashboard — fecho de aba (pagehide)', () => {
  const contexto = { persona: 'gestao', companySelection: 'all' };

  function autenticar(userId: string) {
    mockedUseAuth.mockReturnValue({
      user: { id: userId },
      session: { access_token: 'token-abc' },
    } as unknown as ReturnType<typeof useAuth>);
  }

  it('GRAVA ao fechar a aba: React nao roda cleanup no unload, entao pagehide e a unica chance', () => {
    autenticar('user-21');
    const { builder } = criarInsertPreguicoso();
    mockedFrom.mockReturnValue(builder as unknown as ReturnType<typeof supabase.from>);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchSpy);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 6 * 60_000);
    window.dispatchEvent(new Event('pagehide'));
    relogio.mockRestore();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain('/rest/v1/dashboard_visits');
    expect(JSON.parse(String(init.body))).toMatchObject({
      user_id: 'user-21',
      session_minutes: 6,
      persona: 'gestao',
      company_selection: 'all',
    });
  });

  it('usa keepalive: sem isso o browser CANCELA a request ao destruir o documento', () => {
    autenticar('user-22');
    mockedFrom.mockReturnValue(criarInsertPreguicoso().builder as unknown as ReturnType<typeof supabase.from>);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchSpy);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 6 * 60_000);
    window.dispatchEvent(new Event('pagehide'));
    relogio.mockRestore();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.keepalive).toBe(true);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-abc');
  });

  it('nao duplica: gravou no pagehide, o unmount seguinte NAO grava de novo', () => {
    autenticar('user-23');
    const { builder, emitidos } = criarInsertPreguicoso();
    mockedFrom.mockReturnValue(builder as unknown as ReturnType<typeof supabase.from>);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchSpy);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const { unmount } = renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 9 * 60_000);
    window.dispatchEvent(new Event('pagehide'));
    unmount();
    relogio.mockRestore();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(emitidos).toHaveLength(0);
  });

  it('pagehide antes de 5min nao grava (o guard anti-F5 vale nos dois caminhos)', () => {
    autenticar('user-24');
    mockedFrom.mockReturnValue(criarInsertPreguicoso().builder as unknown as ReturnType<typeof supabase.from>);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchSpy);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 4 * 60_000);
    window.dispatchEvent(new Event('pagehide'));
    relogio.mockRestore();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lente "ver como" ativa: o fetch cru nao pode furar o write-guard', () => {
    autenticar('user-25');
    mockedIsLensActive.mockReturnValue(true);
    mockedFrom.mockReturnValue(criarInsertPreguicoso().builder as unknown as ReturnType<typeof supabase.from>);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchSpy);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 6 * 60_000);
    window.dispatchEvent(new Event('pagehide'));
    relogio.mockRestore();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sensor: o fecho de aba emite visita_tentativa com via=pagehide (a quarta saida vira MEDIDA)', () => {
    autenticar('user-27');
    mockedFrom.mockReturnValue(criarInsertPreguicoso().builder as unknown as ReturnType<typeof supabase.from>);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 201 }));

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 6 * 60_000);
    window.dispatchEvent(new Event('pagehide'));
    relogio.mockRestore();

    expect(mockedTrack).toHaveBeenCalledWith(
      'dashboard.visita_tentativa',
      expect.objectContaining({ motivo: 'gravou', via: 'pagehide' }),
    );
  });

  it('sensor: lente ativa nao fica MUDA — emite motivo=lente_ativa em vez de sumir', () => {
    autenticar('user-28');
    mockedIsLensActive.mockReturnValue(true);
    mockedFrom.mockReturnValue(criarInsertPreguicoso().builder as unknown as ReturnType<typeof supabase.from>);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 201 }));

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 6 * 60_000);
    window.dispatchEvent(new Event('pagehide'));
    relogio.mockRestore();

    expect(mockedTrack).toHaveBeenCalledWith(
      'dashboard.visita_tentativa',
      expect.objectContaining({ motivo: 'lente_ativa', via: 'pagehide' }),
    );
  });

  it('sensor: o unmount depois do pagehide emite motivo=ja_gravado (nao vira silencio)', () => {
    autenticar('user-29');
    mockedFrom.mockReturnValue(criarInsertPreguicoso().builder as unknown as ReturnType<typeof supabase.from>);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 201 }));

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const { unmount } = renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 8 * 60_000);
    window.dispatchEvent(new Event('pagehide'));
    unmount();
    relogio.mockRestore();

    expect(mockedTrack).toHaveBeenCalledWith(
      'dashboard.visita_tentativa',
      expect.objectContaining({ motivo: 'ja_gravado', via: 'unmount' }),
    );
  });

  it('desmontou: o listener de pagehide sai junto (nao grava por componente morto)', () => {
    autenticar('user-26');
    const { builder } = criarInsertPreguicoso();
    mockedFrom.mockReturnValue(builder as unknown as ReturnType<typeof supabase.from>);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchSpy);

    const agora = Date.now();
    const relogio = vi.spyOn(Date, 'now').mockReturnValue(agora);
    const { unmount } = renderHook(() => useRegistrarVisitaDashboard(contexto), { wrapper });
    relogio.mockReturnValue(agora + 2 * 60_000);
    unmount();
    relogio.mockReturnValue(agora + 30 * 60_000);
    window.dispatchEvent(new Event('pagehide'));
    relogio.mockRestore();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useLastVisit — sinal de que a leitura resolveu', () => {
  it('visitaResolvida e FALSE enquanto a leitura do servidor nao voltou', () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-31' } } as ReturnType<typeof useAuth>);
    mockedFrom.mockReturnValue(criarLeituraVisita(null, { pendente: true }));

    const { result } = renderHook(() => useLastVisit(), { wrapper });

    expect(result.current.visitaResolvida).toBe(false);
  });

  it('visitaResolvida vira TRUE quando a leitura resolve', async () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-32' } } as ReturnType<typeof useAuth>);
    const iso = new Date(Date.now() - 90 * 60_000).toISOString();
    mockedFrom.mockReturnValue(criarLeituraVisita(iso));

    const { result } = renderHook(() => useLastVisit(), { wrapper });

    await waitFor(() => expect(result.current.visitaResolvida).toBe(true));
    expect(result.current.minutesSinceLastVisit).toBeGreaterThanOrEqual(90);
  });

  it('sem usuario a leitura ja nasce resolvida (so localStorage, disponivel sincrono)', () => {
    mockedUseAuth.mockReturnValue({ user: null } as ReturnType<typeof useAuth>);

    const { result } = renderHook(() => useLastVisit(), { wrapper });

    expect(result.current.visitaResolvida).toBe(true);
  });
});

describe('useTrackDashboardViewed', () => {
  const contexto = {
    persona: 'gestao',
    personaSource: 'auto',
    companyMode: 'all' as const,
    companyId: 'all',
  };

  it('NAO dispara dashboard.viewed antes da leitura resolver (era isso que enchia o evento de null)', () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-41' } } as ReturnType<typeof useAuth>);
    mockedFrom.mockReturnValue(criarLeituraVisita(null, { pendente: true }));

    renderHook(() => useTrackDashboardViewed(contexto), { wrapper });

    expect(mockedTrack).not.toHaveBeenCalled();
  });

  it('dispara com time_since_last_visit_min PREENCHIDO quando a leitura resolve', async () => {
    mockedUseAuth.mockReturnValue({ user: { id: 'user-42' } } as ReturnType<typeof useAuth>);
    const iso = new Date(Date.now() - 200 * 60_000).toISOString();
    mockedFrom.mockReturnValue(criarLeituraVisita(iso));

    renderHook(() => useTrackDashboardViewed(contexto), { wrapper });

    await waitFor(() => expect(mockedTrack).toHaveBeenCalledTimes(1));
    const [evento, props] = mockedTrack.mock.calls[0] as [string, Record<string, unknown>];
    expect(evento).toBe('dashboard.viewed');
    expect(props.time_since_last_visit_min).toBeGreaterThanOrEqual(200);
    expect(props.persona).toBe('gestao');
    expect(props.time_since_last_visit_resolvido).toBe(true);
  });

  it('timeout ja disparou e a leitura resolve DEPOIS — o evento nao pode sair duas vezes', async () => {
    vi.useFakeTimers();
    try {
      mockedUseAuth.mockReturnValue({ user: { id: 'user-43' } } as ReturnType<typeof useAuth>);
      let resolverLeitura: (v: { data: { visited_at: string } }) => void = () => {};
      const maybeSingle = vi.fn(
        () => new Promise<{ data: { visited_at: string } }>((r) => { resolverLeitura = r; }),
      );
      mockedFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({ range: vi.fn().mockReturnValue({ maybeSingle }) }),
          }),
        }),
      } as unknown as ReturnType<typeof supabase.from>);

      renderHook(() => useTrackDashboardViewed(contexto), { wrapper });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(mockedTrack).toHaveBeenCalledTimes(1);

      resolverLeitura({ data: { visited_at: new Date(Date.now() - 10 * 60_000).toISOString() } });
      await vi.advanceTimersByTimeAsync(500);

      expect(mockedTrack).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leitura travada: o timeout de seguranca dispara mesmo assim (evento nunca pode sumir)', async () => {
    vi.useFakeTimers();
    try {
      mockedUseAuth.mockReturnValue({ user: { id: 'user-44' } } as ReturnType<typeof useAuth>);
      mockedFrom.mockReturnValue(criarLeituraVisita(null, { pendente: true }));

      renderHook(() => useTrackDashboardViewed(contexto), { wrapper });
      expect(mockedTrack).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_000);

      expect(mockedTrack).toHaveBeenCalledTimes(1);
      const [, props] = mockedTrack.mock.calls[0] as [string, Record<string, unknown>];
      expect(props.time_since_last_visit_resolvido).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
