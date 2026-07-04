import { useEffect } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { flush, subscribeToOfflineQueue, type QueuedMutation } from '@/lib/offline-queue';
import { logger } from '@/lib/logger';

type Handler = (variables: unknown) => Promise<boolean>;

interface HandlerEntry {
  handler: Handler;
  /** Query keys (prefixos) a invalidar quando um item deste kind drena com sucesso. */
  invalidateKeys?: readonly QueryKey[];
}

/** Registry global de handlers por kind. */
const handlers = new Map<string, HandlerEntry>();

/**
 * Registra um handler que processará mutations enfileiradas de um determinado kind.
 * Chamar uma única vez (e.g. no mount da página que faz a mutação).
 *
 * Handler retorna:
 *  - true: mutação aplicou; item é removido da fila
 *  - false: mutação ainda falha; item fica na fila com attempts++
 *  - throw: idem
 *
 * `invalidateKeys`: quando o flush drena um item deste kind com sucesso, estas
 * query keys são invalidadas — sem isso, o cache do React Query fica com o estado
 * pré-sync (unidade conferida offline "some" até um refetch natural). Prefixo:
 * ['nfe_conferencia'] casa ['nfe_conferencia', id].
 */
export function registerOfflineHandler<TVars>(
  kind: string,
  handler: (variables: TVars) => Promise<boolean>,
  invalidateKeys?: readonly QueryKey[],
): () => void {
  handlers.set(kind, { handler: handler as Handler, invalidateKeys });
  return () => handlers.delete(kind);
}

/**
 * Hook montado uma vez (no AppShell). Escuta 'online' event e dispara flush
 * que despacha cada item da fila pro handler registrado pra aquele kind.
 * Kinds sem handler registrado ficam na fila (não-destrutivo).
 */
export function useOfflineFlush(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    // Guard de re-entrância: flush() chama writeQueue(), que re-emite pra fila.
    // Sem isso, um item que FALHA persistentemente (ex. RLS) fica na fila → o re-emit
    // re-dispara o flush → loop infinito martelando o backend. O guard garante que o
    // re-emit disparado pelo próprio flush seja ignorado enquanto ele roda.
    let flushing = false;
    const runFlush = async () => {
      if (flushing) return;
      flushing = true;
      // Kinds que drenaram nesta rodada → suas query keys são revalidadas ao fim,
      // pra UI refletir a verdade do servidor após a fila esvaziar.
      const succeededKinds = new Set<string>();
      const dispatcher = async (m: QueuedMutation): Promise<boolean> => {
        const entry = handlers.get(m.kind);
        if (!entry) {
          logger.warn('Offline flush: nenhum handler para kind', { kind: m.kind });
          return false;
        }
        try {
          const ok = await entry.handler(m.variables);
          if (ok) succeededKinds.add(m.kind);
          return ok;
        } catch (e) {
          logger.warn('Offline flush: handler throw', {
            kind: m.kind,
            error: e instanceof Error ? e.message : String(e),
          });
          return false;
        }
      };
      try {
        await flush(dispatcher);
        // Revalidação pós-flush (non-blocking): reconcilia o cache com o servidor
        // pros kinds que efetivamente drenaram. Sem isto, o que foi confirmado
        // offline só aparecia no próximo refetch natural (dívida corrigida).
        for (const kind of succeededKinds) {
          for (const key of handlers.get(kind)?.invalidateKeys ?? []) {
            void queryClient.invalidateQueries({ queryKey: key });
          }
        }
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
  }, [queryClient]);
}

/** Helper de teste — não exportar via barrel. */
export function __clearHandlersForTest(): void {
  handlers.clear();
}
