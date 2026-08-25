import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fake com a SEMÂNTICA REAL de super property: o que foi registrado entra em todo
// capture posterior. É isso que faz o teste distinguir `register()` de "carimbar
// dentro de track()" — só o primeiro alcança autocapture/$pageview/$exception.
const { fake, capturas } = vi.hoisted(() => {
  const capturas: Array<{ evento: string; props: Record<string, unknown> }> = [];
  let superProps: Record<string, unknown> = {};
  const fake = {
    init: vi.fn(),
    register: vi.fn((p: Record<string, unknown>) => {
      superProps = { ...superProps, ...p };
    }),
    capture: vi.fn((evento: string, props?: Record<string, unknown>) => {
      capturas.push({ evento, props: { ...superProps, ...props } });
    }),
    reset: vi.fn(() => {
      superProps = {};
    }),
    identify: vi.fn(),
    group: vi.fn(),
    captureException: vi.fn(),
    __limpar: () => {
      capturas.length = 0;
      superProps = {};
    },
  };
  return { fake, capturas };
});

vi.mock('posthog-js', () => ({ default: fake }));

const BUILD_DE_TESTE = 'index-TESTE123';

async function carregarAnalytics() {
  vi.resetModules();
  return import('@/lib/analytics');
}

beforeEach(() => {
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_teste');
  fake.__limpar();
  fake.init.mockClear();
  fake.register.mockClear();
  fake.capture.mockClear();
  document.head.innerHTML = '';
  const s = document.createElement('script');
  s.type = 'module';
  s.setAttribute('src', `/assets/${BUILD_DE_TESTE}.js`);
  document.head.appendChild(s);
});

afterEach(() => {
  vi.unstubAllEnvs();
  document.head.innerHTML = '';
});

describe('analytics carimba o build que está EXECUTANDO', () => {
  it('registra build_id como super property no init (alcança autocapture e $pageview)', async () => {
    const { initAnalytics } = await carregarAnalytics();
    initAnalytics();
    await vi.waitFor(() => expect(fake.register).toHaveBeenCalled());
    expect(fake.register).toHaveBeenCalledWith(expect.objectContaining({ build_id: BUILD_DE_TESTE }));
  });

  it('evento ENFILEIRADO antes do init drena JÁ com o build_id', async () => {
    const { initAnalytics, track } = await carregarAnalytics();
    track('diagnostico.pre_init'); // SDK ainda não carregou → vai pra fila
    expect(fake.capture).not.toHaveBeenCalled();

    initAnalytics();
    await vi.waitFor(() => expect(fake.capture).toHaveBeenCalled());

    const evento = capturas.find((c) => c.evento === 'diagnostico.pre_init');
    expect(evento?.props.build_id).toBe(BUILD_DE_TESTE);
  });

  it('track pós-init carrega o build_id sem apagar as properties do chamador', async () => {
    const { initAnalytics, track } = await carregarAnalytics();
    initAnalytics();
    await vi.waitFor(() => expect(fake.register).toHaveBeenCalled());

    track('pedido.criado', { valor: 1234.5 });
    const evento = capturas.find((c) => c.evento === 'pedido.criado');
    expect(evento?.props.build_id).toBe(BUILD_DE_TESTE);
    expect(evento?.props.valor).toBe(1234.5);
  });

  it('pageview também carrega — o denominador da adoção não pode ficar cego', async () => {
    const { initAnalytics, pageview } = await carregarAnalytics();
    initAnalytics();
    await vi.waitFor(() => expect(fake.register).toHaveBeenCalled());

    pageview('/picking');
    const evento = capturas.find((c) => c.evento === '$pageview');
    expect(evento?.props.build_id).toBe(BUILD_DE_TESTE);
  });
});
