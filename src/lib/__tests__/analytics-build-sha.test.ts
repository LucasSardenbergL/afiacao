import { describe, it, expect, vi, beforeEach } from 'vitest';

declare const __COMMIT_SHA__: string;

/**
 * O `build_sha` responde "qual build o cliente está EXECUTANDO" — que não é o
 * mesmo que o build servido: o SW usa `registerType:'prompt'` e espera o clique.
 * Sem esta super-property, descobrir a versão de um cliente exige abrir o
 * browser dele (foi o que custou o teste de 2026-08-24).
 *
 * Falha silenciosa é a classe de bug aqui: remover o `register` não quebra nada
 * — os eventos continuam saindo, só que sem a dimensão. Por isso o teste.
 */
async function initComPosthogFalso() {
  const instance = { register: vi.fn(), opt_out_capturing: vi.fn() };
  const init = vi.fn((_key: string, opts: { loaded?: (i: unknown) => void }) => {
    opts.loaded?.(instance);
  });
  vi.doMock('posthog-js', () => ({ default: { init, capture: vi.fn() } }));
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_fake_para_teste');
  const { initAnalytics } = await import('@/lib/analytics');
  initAnalytics();
  await vi.waitFor(() => expect(init).toHaveBeenCalled());
  return instance;
}

describe('analytics — build_sha', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('registra o build_sha como super-property no loaded do posthog', async () => {
    const instance = await initComPosthogFalso();
    expect(instance.register).toHaveBeenCalledWith({ build_sha: __COMMIT_SHA__ });
  });

  it('o build_sha é a const injetada pelo build, não um literal solto', async () => {
    const instance = await initComPosthogFalso();
    const [[props]] = instance.register.mock.calls as [[{ build_sha: string }]];
    // casa contra o define do vitest.config — se alguém trocar por string fixa
    // no código-fonte, este assert cai junto com o de cima
    expect(props.build_sha).toBe(__COMMIT_SHA__);
    expect(typeof props.build_sha).toBe('string');
    expect(props.build_sha.length).toBeGreaterThan(0);
  });
});
