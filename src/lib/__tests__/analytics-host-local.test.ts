/**
 * @vitest-environment jsdom
 *
 * Build de produção servido em localhost (`vite preview` do /qa e /browse) não
 * pode mandar telemetria para o PostHog de produção — virava alerta `erro_app`
 * falso quando o preview era recompilado e o chunk antigo sumia.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fake } = vi.hoisted(() => {
  const fake = {
    init: vi.fn(),
    register: vi.fn(),
    capture: vi.fn(),
    opt_out_capturing: vi.fn(),
  };
  return { fake };
});

vi.mock('posthog-js', () => ({ default: fake }));

async function carregarAnalytics() {
  vi.resetModules();
  return import('@/lib/analytics');
}

/** Dispara o `loaded` que o initAnalytics passou ao posthog.init. */
async function rodarLoaded() {
  const { initAnalytics } = await carregarAnalytics();
  initAnalytics();
  await vi.waitFor(() => expect(fake.init).toHaveBeenCalled());
  const opcoes = fake.init.mock.calls[0][1] as { loaded: (p: typeof fake) => void };
  opcoes.loaded(fake);
}

beforeEach(() => {
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_teste');
  vi.stubEnv('DEV', false);
  fake.init.mockClear();
  fake.opt_out_capturing.mockClear();
});

describe('ehHostLocal', () => {
  it.each(['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '[::1]', '::1'])('%s é local', async (h) => {
    const { ehHostLocal } = await carregarAnalytics();
    expect(ehHostLocal(h)).toBe(true);
  });

  it.each(['afiacao.lovable.app', 'app.colacor.com.br', 'localhost.evil.com', '127.0.0.2.nip.io'])(
    '%s não é local',
    async (h) => {
      const { ehHostLocal } = await carregarAnalytics();
      expect(ehHostLocal(h)).toBe(false);
    },
  );
});

describe('opt-out de captura no build de produção', () => {
  it('desliga a captura quando o host é localhost (vite preview)', async () => {
    // jsdom serve em http://localhost/ por padrão.
    expect(window.location.hostname).toBe('localhost');
    await rodarLoaded();
    expect(fake.opt_out_capturing).toHaveBeenCalledTimes(1);
  });

  it('mantém a captura no host publicado', async () => {
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      hostname: 'afiacao.lovable.app',
    } as Location);
    await rodarLoaded();
    expect(fake.opt_out_capturing).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
