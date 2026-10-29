import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { RealtimeClient } from '@supabase/supabase-js';

// Client REAL do realtime-js (mesmo modelo do useCockpitChannel.topic.test):
// é ele que deduplica canal por topic e lança "cannot add `postgres_changes`
// callbacks ... after `subscribe()`". Socket em porta morta → o canal fica em
// 'joining', que é o estado em que o .on() lança.
const realtime = new RealtimeClient('ws://127.0.0.1:1/realtime/v1', {
  params: { apikey: 'teste' },
  reconnectAfterMs: () => 60_000,
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: (topic: string) => realtime.channel(topic),
    // removeChannel real é async (aguarda o phx_leave) — o canal continua na
    // lista até lá; não remover aqui reproduz a janela de corrida.
    removeChannel: vi.fn(),
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [] }) }) }),
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

let authUser: { id: string } | null = { id: 'u1' };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: authUser }) }));

import { usePushNotifications } from '../usePushNotifications';

beforeEach(() => {
  vi.stubGlobal('Notification', { permission: 'granted' });
  Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true });
  authUser = { id: 'u1' };
});

afterEach(() => {
  cleanup();
  realtime.disconnect();
  vi.unstubAllGlobals();
});

describe('usePushNotifications — topic geracional', () => {
  it('TOKEN_REFRESHED (novo objeto user, mesmo id) re-roda o efeito sem lançar', () => {
    const { rerender } = renderHook(() => usePushNotifications());
    // O AuthContext faz setUser(session.user) a cada evento de auth: objeto novo.
    authUser = { id: 'u1' };
    expect(() => rerender()).not.toThrow();
  });

  it('dois mounts simultâneos não lançam', () => {
    renderHook(() => usePushNotifications());
    expect(() => renderHook(() => usePushNotifications())).not.toThrow();
  });
});
