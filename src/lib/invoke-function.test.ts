import { describe, it, expect, vi, beforeEach } from 'vitest';

// O erro do supabase-js sempre traz o genérico "non-2xx status code"; o motivo
// REAL (e o status) vivem na Response guardada em `context`. É desse elo que
// depende o copiloto distinguir "sua cota acabou" (esperar) de falha
// transitória (retentar) — sem ele, o hook volta a martelar de 8 em 8s.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(() =>
        Promise.resolve({ data: { session: { access_token: 'token-de-teste' } } }),
      ),
    },
    functions: { invoke: vi.fn() },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { supabase } from '@/integrations/supabase/client';
import { EdgeFunctionError, invokeFunction } from '@/lib/invoke-function';

const invokeMock = supabase.functions.invoke as unknown as ReturnType<typeof vi.fn>;

/** Reproduz o formato do FunctionsHttpError: mensagem genérica + Response. */
function erroDeEdge(status: number, corpo: unknown, headers: Record<string, string> = {}) {
  return {
    data: null,
    error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      context: new Response(JSON.stringify(corpo), { status, headers }),
    }),
  };
}

describe('invokeFunction — status e Retry-After', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('propaga o status HTTP da Response, não o do erro do supabase', async () => {
    invokeMock.mockResolvedValue(
      erroDeEdge(429, { error: 'Você atingiu seu limite de 20 análises do copiloto nesta hora.' }),
    );

    await expect(invokeFunction('copilot-analyze')).rejects.toMatchObject({
      name: 'EdgeFunctionError',
      status: 429,
    });
  });

  it('propaga a mensagem do servidor no lugar do genérico non-2xx', async () => {
    invokeMock.mockResolvedValue(erroDeEdge(429, { error: 'Libera em 22 minutos.' }));

    await expect(invokeFunction('copilot-analyze')).rejects.toThrow('Libera em 22 minutos.');
  });

  it('lê Retry-After quando a edge manda', async () => {
    invokeMock.mockResolvedValue(
      erroDeEdge(429, { error: 'cota' }, { 'Retry-After': '1320' }),
    );

    try {
      await invokeFunction('copilot-analyze');
      throw new Error('devia ter lançado');
    } catch (e) {
      expect(e).toBeInstanceOf(EdgeFunctionError);
      expect((e as EdgeFunctionError).retryAfterSeconds).toBe(1320);
    }
  });

  it('sem Retry-After utilizável, deixa undefined em vez de fabricar 0', async () => {
    // `Number(null)` é 0 — um retry de 0s reabriria o martelo imediatamente.
    for (const headers of [{}, { 'Retry-After': 'depois' }, { 'Retry-After': '0' }]) {
      invokeMock.mockResolvedValue(erroDeEdge(429, { error: 'cota' }, headers));
      try {
        await invokeFunction('copilot-analyze');
        throw new Error('devia ter lançado');
      } catch (e) {
        expect((e as EdgeFunctionError).retryAfterSeconds).toBeUndefined();
      }
    }
  });

  it('distingue 503 (transitório) de 429 (cota) pelo status', async () => {
    invokeMock.mockResolvedValue(
      erroDeEdge(503, { error: 'Não consegui verificar seu limite de uso agora.' }),
    );

    try {
      await invokeFunction('identify-tool');
      throw new Error('devia ter lançado');
    } catch (e) {
      expect((e as EdgeFunctionError).status).toBe(503);
    }
  });

  it('corpo não-JSON não derruba a extração — cai no genérico com o status', async () => {
    invokeMock.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        context: new Response('<html>502</html>', { status: 502 }),
      }),
    });

    try {
      await invokeFunction('identify-tool');
      throw new Error('devia ter lançado');
    } catch (e) {
      expect((e as EdgeFunctionError).status).toBe(502);
      expect((e as Error).message).toContain('non-2xx');
    }
  });

  it('sucesso devolve os dados e não lança', async () => {
    invokeMock.mockResolvedValue({ data: { ok: true }, error: null });
    await expect(invokeFunction<{ ok: boolean }>('identify-tool')).resolves.toEqual({ ok: true });
  });
});
