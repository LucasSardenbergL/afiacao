import { enqueue, flush } from './offline-queue';
import { logger } from './logger';

/**
 * Bus de handlers pra processar mutações enfileiradas em offline-queue.
 *
 * Padrão de uso:
 *  1. Em load do app, registrar handlers globais por `kind` (ver `registerOfflineHandler`)
 *  2. Em mutações operacionais, fazer try/catch — se erro AND offline, chamar `enqueueForLater`
 *  3. Setup do listener `online` (via `setupAutoFlushOnReconnect`) dispara `flushAll`
 *     automaticamente quando conexão voltar
 *
 * Conservative v1:
 *  - Handler precisa ser idempotente (pode rodar 2× se conexão flapping)
 *  - Falha mantém item na fila com `attempts++`. Não há cap automático — usuário pode
 *    limpar manualmente via `clearOfflineQueue` se algum item ficar permanentemente preso
 *  - Sem conflict resolution: handler aplica direto. Last-write-wins na semântica do DB
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler<TVars = any> = (vars: TVars) => Promise<void>;

const handlers = new Map<string, Handler>();

/**
 * Registra um handler pra um `kind` de mutação enfileirada.
 * Idempotente — registrar 2× substitui pelo último.
 *
 * `kind` deve ser estável (não regenerado por sessão) — usado como chave de despacho.
 * Convenção: "<area>.<action>" (ex: "recebimento.report-divergencia", "picking.confirm-unit").
 */
export function registerOfflineHandler<TVars>(
  kind: string,
  handler: Handler<TVars>,
): void {
  handlers.set(kind, handler as Handler);
}

/**
 * Enfileira uma mutação pra processar depois (quando voltar online).
 * Retorna o id do item enfileirado.
 */
export async function enqueueForLater<TVars>(
  kind: string,
  variables: TVars,
): Promise<string> {
  return enqueue(kind, variables);
}

/**
 * Tenta processar todas as mutações enfileiradas usando os handlers registrados.
 * Mutações sem handler ficam na fila (handler pode aparecer depois — ex: a page
 * que registra ainda não foi montada).
 * Mutações que throws ficam na fila com `attempts++`.
 */
export async function flushAll(): Promise<{
  success: number;
  failed: number;
  unknownKind: number;
}> {
  let unknownKind = 0;
  const result = await flush(async (mutation) => {
    const handler = handlers.get(mutation.kind);
    if (!handler) {
      unknownKind++;
      return false; // mantém na fila
    }
    try {
      await handler(mutation.variables);
      return true;
    } catch (e) {
      logger.warn('Offline flush handler falhou', {
        kind: mutation.kind,
        attempts: mutation.attempts,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  });
  if (result.success > 0 || result.failed > 0) {
    logger.info('Offline flush concluído', { ...result, unknownKind });
  }
  return { ...result, unknownKind };
}

let listenerSetup = false;

/**
 * Idempotente: setup listener global do evento `online` — dispara `flushAll`
 * automaticamente quando conexão voltar.
 * Retorna função cleanup pra remover o listener.
 *
 * Chamar 1× no mount do AppShell (via `OfflineFlusher` component).
 */
export function setupAutoFlushOnReconnect(): () => void {
  if (typeof window === 'undefined' || listenerSetup) return () => {};
  listenerSetup = true;
  const handler = () => {
    void flushAll();
  };
  window.addEventListener('online', handler);
  return () => {
    window.removeEventListener('online', handler);
    listenerSetup = false;
  };
}
