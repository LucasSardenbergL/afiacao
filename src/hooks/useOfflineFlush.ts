import { useEffect } from 'react';
import { flush, subscribeToOfflineQueue, type QueuedMutation } from '@/lib/offline-queue';
import { logger } from '@/lib/logger';

type Handler = (variables: unknown) => Promise<boolean>;

/** Registry global de handlers por kind. */
const handlers = new Map<string, Handler>();

/**
 * Registra um handler que processará mutations enfileiradas de um determinado kind.
 * Chamar uma única vez (e.g. no mount da página que faz a mutação).
 *
 * Handler retorna:
 *  - true: mutação aplicou; item é removido da fila
 *  - false: mutação ainda falha; item fica na fila com attempts++
 *  - throw: idem
 */
export function registerOfflineHandler<TVars>(
  kind: string,
  handler: (variables: TVars) => Promise<boolean>,
): () => void {
  handlers.set(kind, handler as Handler);
  return () => handlers.delete(kind);
}

/**
 * Hook montado uma vez (no AppShell). Escuta 'online' event e dispara flush
 * que despacha cada item da fila pro handler registrado pra aquele kind.
 * Kinds sem handler registrado ficam na fila (não-destrutivo).
 */
export function useOfflineFlush(): void {
  useEffect(() => {
    const dispatcher = async (m: QueuedMutation): Promise<boolean> => {
      const h = handlers.get(m.kind);
      if (!h) {
        logger.warn('Offline flush: nenhum handler para kind', { kind: m.kind });
        return false;
      }
      try {
        return await h(m.variables);
      } catch (e) {
        logger.warn('Offline flush: handler throw', {
          kind: m.kind,
          error: e instanceof Error ? e.message : String(e),
        });
        return false;
      }
    };

    // Guard de re-entrância: flush() chama writeQueue(), que re-emite pra fila.
    // Sem isso, um item que FALHA persistentemente (ex. RLS) fica na fila → o re-emit
    // re-dispara o flush → loop infinito martelando o backend. O guard garante que o
    // re-emit disparado pelo próprio flush seja ignorado enquanto ele roda.
    let flushing = false;
    const runFlush = async () => {
      if (flushing) return;
      flushing = true;
      try {
        await flush(dispatcher);
      } finally {
        flushing = false;
      }
    };

    const onOnline = () => {
      void runFlush();
    };

    window.addEventListener('online', onOnline);

    // Ao montar, se já tem itens E está online, tenta flush imediatamente.
    const unsub = subscribeToOfflineQueue((depth) => {
      if (depth > 0 && typeof navigator !== 'undefined' && navigator.onLine) {
        void runFlush();
      }
    });

    return () => {
      window.removeEventListener('online', onOnline);
      unsub();
    };
  }, []);
}

/** Helper de teste — não exportar via barrel. */
export function __clearHandlersForTest(): void {
  handlers.clear();
}
