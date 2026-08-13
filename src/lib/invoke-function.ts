import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';
import type { FunctionInvokeOptions } from '@supabase/supabase-js';

class AuthRequiredError extends Error {
  constructor() {
    super('Sessão expirada. Faça login novamente.');
    this.name = 'AuthRequiredError';
  }
}

export class EdgeFunctionError extends Error {
  constructor(
    message: string,
    public functionName: string,
    /** Status HTTP real da edge. Sem ele, quem chama não distingue "sua cota
     *  acabou" (429, esperar adianta) de falha transitória (retentar adianta). */
    public status?: number,
    /** Segundos do header `Retry-After`, quando a edge mandou. */
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'EdgeFunctionError';
  }
}

/**
 * Centralized helper to invoke Supabase edge functions with session validation.
 * Throws AuthRequiredError if no active session, EdgeFunctionError on function errors.
 */
export async function invokeFunction<T = unknown>(
  functionName: string,
  body?: FunctionInvokeOptions['body'],
): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new AuthRequiredError();
  }

  const { data, error } = await supabase.functions.invoke(functionName, {
    body,
  });

  if (error) {
    const errWithMeta = error as { message?: string; code?: string; status?: number; context?: unknown };
    // FunctionsHttpError expõe a Response da função em `context`. O corpo traz o erro
    // REAL do servidor (ex.: "Falha ao autenticar na Nvoip: 401"); o `error.message` do
    // supabase é sempre o genérico "Edge Function returned a non-2xx status code".
    let serverMessage: string | undefined;
    let httpStatus: number | undefined = errWithMeta.status;
    let retryAfterSeconds: number | undefined;
    const ctx = errWithMeta.context;
    if (ctx && typeof (ctx as Response).clone === 'function') {
      const resp = ctx as Response;
      // O status vive na Response, não em `error.status` — que costuma vir vazio.
      if (typeof resp.status === 'number') httpStatus = resp.status;
      const retry = Number(resp.headers?.get('Retry-After'));
      if (Number.isFinite(retry) && retry > 0) retryAfterSeconds = retry;
      try {
        const parsed: unknown = await resp.clone().json();
        if (
          parsed && typeof parsed === 'object' &&
          'error' in parsed && typeof (parsed as { error: unknown }).error === 'string'
        ) {
          serverMessage = (parsed as { error: string }).error;
        }
      } catch {
        /* corpo não-JSON ou já consumido — mantém o fallback genérico */
      }
    }
    logger.error(`Edge function failed: ${functionName}`, {
      functionName,
      errorCode: errWithMeta.code,
      httpStatus,
      serverMessage,
      error,
    });
    throw new EdgeFunctionError(
      serverMessage || error.message || `Erro ao chamar ${functionName}`,
      functionName,
      httpStatus,
      retryAfterSeconds,
    );
  }

  return data as T;
}
