import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// device.ts (e o logger que ele importa) tocam o supabase client no topo do
// módulo — mockamos o mínimo pra o import não quebrar e pra observar a RPC.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  },
}));

import { limparPushDoDevice } from './device';
import { supabase } from '@/integrations/supabase/client';

function defineGlobal(alvo: object, prop: string, value: unknown) {
  Object.defineProperty(alvo, prop, { configurable: true, value });
}

describe('limparPushDoDevice — logout best-effort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // suportaPush() exige serviceWorker + PushManager + Notification presentes.
    defineGlobal(window, 'PushManager', {});
    defineGlobal(window, 'Notification', {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'PushManager');
    Reflect.deleteProperty(window, 'Notification');
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  // O bug: no preview/iframe o service worker nunca fica "ready"; como o signOut
  // faz `await limparPushDoDevice()`, um ready pendurado trava o logout pra sempre.
  // O try/catch original só protege contra THROW — não contra HANG.
  it('resolve mesmo quando serviceWorker.ready nunca resolve (logout não pode travar)', async () => {
    defineGlobal(navigator, 'serviceWorker', { ready: new Promise(() => {}) });

    const PENDURADO = Symbol('pendurado');
    const corrida = Promise.race([
      limparPushDoDevice().then(() => 'resolveu' as const),
      new Promise<typeof PENDURADO>((r) => setTimeout(() => r(PENDURADO), 5_000)),
    ]);

    // Avança o relógio além de qualquer teto interno razoável. Sem o fix,
    // limparPushDoDevice segue pendurada e só o marcador PENDURADO vence.
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(corrida).resolves.toBe('resolveu');
  });

  // Não-regressão: o teto não pode ter quebrado o fluxo normal.
  it('caminho feliz: desinscreve o device e apaga a linha via RPC', async () => {
    const unsubscribe = vi.fn(() => Promise.resolve(true));
    defineGlobal(navigator, 'serviceWorker', {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: () => Promise.resolve({ endpoint: 'https://push/abc', unsubscribe }),
        },
      }),
    });

    await limparPushDoDevice();

    expect(vi.mocked(supabase.rpc)).toHaveBeenCalledWith('delete_push_subscription', {
      p_endpoint: 'https://push/abc',
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('retorna cedo (sem tocar a RPC) quando o navegador não suporta push', async () => {
    Reflect.deleteProperty(window, 'PushManager'); // deixa suportaPush() falso

    await limparPushDoDevice();

    expect(vi.mocked(supabase.rpc)).not.toHaveBeenCalled();
  });
});
