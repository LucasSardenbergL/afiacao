/**
 * Logger estruturado central do Afiação.
 *
 * Substitui console.* espalhados pelo código com uma API uniforme,
 * enriquecimento automático de contexto e buffer circular para debug.
 *
 * @example
 *   import { logger } from '@/lib/logger';
 *   logger.error('Failed to submit order', { orderId, customerId });
 *   logger.error(new Error('Network timeout'), { endpoint });
 */

import { supabase } from '@/integrations/supabase/client';

export type Severity = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export type LogContext = Record<string, unknown>;

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

export interface LogEntry {
  timestamp: string;
  severity: Severity;
  message: string;
  context: LogContext;
  error?: SerializedError;
}

const BUFFER_SIZE = 50;
const recentLogs: LogEntry[] = [];

// Cache leve do user_id para não chamar getSession a cada log.
// Atualizado de forma assíncrona via auth state change.
let cachedUserId: string | null = null;

function initAuthCache(): void {
  if (typeof window === 'undefined') return;
  try {
    void supabase.auth.getSession().then(({ data }) => {
      cachedUserId = data.session?.user?.id ?? null;
    });
    supabase.auth.onAuthStateChange((_event, session) => {
      cachedUserId = session?.user?.id ?? null;
    });
  } catch {
    // Em ambiente de teste o supabase pode não estar disponível.
  }
}
initAuthCache();

function isDev(): boolean {
  try {
    return import.meta.env.DEV === true;
  } catch {
    return false;
  }
}

function getBuildVersion(): string {
  try {
    return (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'dev';
  } catch {
    return 'dev';
  }
}

function getRoute(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.location?.pathname;
}

function serializeError(err: Error): SerializedError {
  const out: SerializedError = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  // Error.cause (ES2022)
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause !== undefined) out.cause = cause;
  return out;
}

function buildEntry(
  severity: Severity,
  messageOrError: string | Error,
  userContext?: LogContext,
): LogEntry {
  const autoContext: LogContext = {
    route: getRoute(),
    user_id: cachedUserId,
    build: getBuildVersion(),
  };

  // Remover chaves auto cujo valor é undefined/null para não poluir
  for (const key of Object.keys(autoContext)) {
    if (autoContext[key] == null) delete autoContext[key];
  }

  let message: string;
  let error: SerializedError | undefined;

  if (messageOrError instanceof Error) {
    message = messageOrError.message;
    error = serializeError(messageOrError);
  } else {
    message = messageOrError;
  }

  // Precedência: contexto do dev sobrescreve auto
  const context: LogContext = { ...autoContext, ...(userContext ?? {}) };

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    severity,
    message,
    context,
  };
  if (error) entry.error = error;
  return entry;
}

function pushBuffer(entry: LogEntry): void {
  recentLogs.push(entry);
  if (recentLogs.length > BUFFER_SIZE) {
    recentLogs.splice(0, recentLogs.length - BUFFER_SIZE);
  }
}

function emit(entry: LogEntry): void {
  const dev = isDev();
  const prefix = `[${entry.severity.toUpperCase()} ${entry.timestamp}]`;
  const payload = entry.error
    ? { ...entry.context, error: entry.error }
    : entry.context;
  const hasPayload = Object.keys(payload).length > 0;

  if (dev) {
    // Em dev, tudo passa formatado
    const args: unknown[] = hasPayload ? [prefix, entry.message, payload] : [prefix, entry.message];
    switch (entry.severity) {
      case 'debug':
        console.debug(...args);
        break;
      case 'info':
        console.info(...args);
        break;
      case 'warn':
        console.warn(...args);
        break;
      case 'error':
      case 'critical':
        console.error(...args);
        break;
    }
    return;
  }

  // Produção
  switch (entry.severity) {
    case 'debug':
      // silencioso em prod
      return;
    case 'info':
      console.info(entry.message);
      return;
    case 'warn':
      console.warn(prefix, entry.message, hasPayload ? payload : '');
      return;
    case 'error':
    case 'critical':
      console.error(prefix, entry.message, hasPayload ? payload : '');
      // TODO(sentry): quando configurar Sentry, descomentar:
      // const SentryGlobal = (window as unknown as { Sentry?: { captureException: (e: unknown, opts?: unknown) => void } }).Sentry;
      // if (SentryGlobal) {
      //   const errInstance = entry.error
      //     ? Object.assign(new Error(entry.error.message), entry.error)
      //     : new Error(entry.message);
      //   SentryGlobal.captureException(errInstance, {
      //     extra: entry.context,
      //     level: entry.severity === 'critical' ? 'fatal' : 'error',
      //   });
      // }
      return;
  }
}

function log(severity: Severity, messageOrError: string | Error, context?: LogContext): void {
  const entry = buildEntry(severity, messageOrError, context);
  pushBuffer(entry);
  emit(entry);
}

export const logger = {
  debug: (msg: string | Error, ctx?: LogContext) => log('debug', msg, ctx),
  info: (msg: string | Error, ctx?: LogContext) => log('info', msg, ctx),
  warn: (msg: string | Error, ctx?: LogContext) => log('warn', msg, ctx),
  error: (msg: string | Error, ctx?: LogContext) => log('error', msg, ctx),
  critical: (msg: string | Error, ctx?: LogContext) => log('critical', msg, ctx),

  /** Retorna cópia dos últimos 50 logs (circular buffer). Útil em suporte. */
  getRecentLogs(): LogEntry[] {
    return [...recentLogs];
  },

  /** Limpa o buffer. Usado principalmente em testes. */
  _clearBuffer(): void {
    recentLogs.length = 0;
  },

  /** Permite injetar user_id em testes. */
  _setUserIdForTest(id: string | null): void {
    cachedUserId = id;
  },
};

export type Logger = typeof logger;
