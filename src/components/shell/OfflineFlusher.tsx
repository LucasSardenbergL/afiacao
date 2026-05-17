import { useEffect } from 'react';
import { setupAutoFlushOnReconnect } from '@/lib/offline-flush-bus';

/**
 * Componente sem render — só monta o listener global de `online` que dispara
 * `flushAll()` da fila offline. Idempotente — montar 1× no AppShell é suficiente.
 *
 * Handlers individuais precisam ser registrados via `registerOfflineHandler(kind, fn)`
 * nos arquivos que enfileiram. Convenção típica: em `useEffect` da página que tem a
 * mutação correspondente.
 */
export function OfflineFlusher() {
  useEffect(() => {
    const cleanup = setupAutoFlushOnReconnect();
    return cleanup;
  }, []);
  return null;
}
