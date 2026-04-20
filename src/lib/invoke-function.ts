import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';

export class AuthRequiredError extends Error {
  constructor() {
    super('Sessão expirada. Faça login novamente.');
    this.name = 'AuthRequiredError';
  }
}

export class EdgeFunctionError extends Error {
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
  body?: Record<string, unknown> | FormData,
): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new AuthRequiredError();
  }

  const { data, error } = await supabase.functions.invoke(functionName, {
    body: body as any,
  });

  if (error) {
    const errWithMeta = error as { message?: string; code?: string; status?: number };
    logger.error(`Edge function failed: ${functionName}`, {
      functionName,
      errorCode: errWithMeta.code,
      httpStatus: errWithMeta.status,
      error,
    });
    throw new EdgeFunctionError(
      error.message || `Erro ao chamar ${functionName}`,
      functionName,
    );
  }

  return data as T;
}
