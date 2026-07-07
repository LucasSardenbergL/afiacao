import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';
import type { FunctionInvokeOptions } from '@supabase/supabase-js';

class AuthRequiredError extends Error {
  constructor() {
    super('Sessão expirada. Faça login novamente.');
    this.name = 'AuthRequiredError';
  }
}

class EdgeFunctionError extends Error {
  constructor(message: string, public functionName: string) {
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
    const ctx = errWithMeta.context;
    if (ctx && typeof (ctx as Response).clone === 'function') {
      try {
        const parsed: unknown = await (ctx as Response).clone().json();
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
      httpStatus: errWithMeta.status,
      serverMessage,
      error,
    });
    throw new EdgeFunctionError(
      serverMessage || error.message || `Erro ao chamar ${functionName}`,
      functionName,
    );
  }

  return data as T;
}
