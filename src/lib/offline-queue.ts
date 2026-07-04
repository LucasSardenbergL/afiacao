/**
 * Fila offline de mutações (scaffold para #20 do roadmap UX).
 *
 * O que esta v1 entrega:
 *  - API estável (`enqueue`, `flush`, `getOfflineQueueDepth`, `subscribeToOfflineQueue`)
 *  - Persistência simples em localStorage (será migrada para IndexedDB quando #20 for executado a fundo)
 *  - Subscription pra UI reagir a mudanças no depth
 *
 * O que NÃO está aqui ainda (por design):
 *  - Conflict resolution
 *  - Background sync via service worker (precisa workbox config)
 *  - Retry exponencial granular por tipo de mutação
 *
 * Hoje: o `NetworkStatusIndicator` lê depth para mostrar contador. Páginas críticas (Picking,
 * RecebimentoConferencia, UnifiedOrder) podem começar a usar `enqueue()` em onError de mutações
 * quando offline; o flush manual é exposto pra ser disparado quando a conexão voltar.
 */

import { track } from '@/lib/analytics';

const STORAGE_KEY = 'offline_queue_v1';

export interface QueuedMutation<TVars = unknown> {
  id: string;
  /** Identificador da operação (ex: "picking.confirm", "recebimento.scan-lote"). */
  kind: string;
  variables: TVars;
  enqueuedAt: string;
  attempts: number;
  lastError?: string;
}

type Listener = (depth: number) => void;
const listeners = new Set<Listener>();

function emit(depth: number) {
  listeners.forEach((l) => {
    try {
      l(depth);
    } catch {
      // ignora handler com bug
    }
  });
}

function readQueue(): QueuedMutation[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueuedMutation[];
  } catch {
    return [];
  }
}

function writeQueue(items: QueuedMutation[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  emit(items.length);
}

export async function enqueue<TVars>(kind: string, variables: TVars): Promise<string> {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const items = readQueue();
  items.push({
    id,
    kind,
    variables,
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
  });
  writeQueue(items);
  track('offline.queued', { kind, queue_depth: items.length });
  return id;
}

export async function getOfflineQueueDepth(): Promise<number> {
  return readQueue().length;
}

/** Retorna as mutações enfileiradas de um determinado kind (na ordem de enfileiramento). */
export function getQueuedByKind<TVars = unknown>(kind: string): QueuedMutation<TVars>[] {
  return readQueue().filter((m): m is QueuedMutation<TVars> => m.kind === kind);
}

/**
 * Tenta processar todas as mutações da fila usando o handler fornecido.
 * Handler retorna `true` em sucesso (item é removido da fila) ou `false` (mantém com attempts++).
 * Handler que dispara erro também mantém com attempts++.
 */
export async function flush(
  handler: (mutation: QueuedMutation) => Promise<boolean>,
): Promise<{ success: number; failed: number }> {
  const items = readQueue();
  const succeeded = new Set<string>();
  const failedById = new Map<string, QueuedMutation>();
  let success = 0;
  let failed = 0;
  for (const item of items) {
    try {
      const ok = await handler(item);
      if (ok) {
        succeeded.add(item.id);
        success++;
      } else {
        failedById.set(item.id, { ...item, attempts: item.attempts + 1 });
        failed++;
      }
    } catch (e) {
      failedById.set(item.id, {
        ...item,
        attempts: item.attempts + 1,
        lastError: e instanceof Error ? e.message : String(e),
      });
      failed++;
    }
  }
  // Re-lê a fila ATUAL em vez de sobrescrever com o snapshot: `enqueue()` pode ter
  // rodado durante os awaits do handler (rede intermitente do galpão). Remove só os
  // processados com sucesso (por id), aplica attempts++ nos que falharam, e preserva
  // intactos os que chegaram durante o flush.
  const remaining = readQueue()
    .filter((m) => !succeeded.has(m.id))
    .map((m) => failedById.get(m.id) ?? m);
  writeQueue(remaining);
  track('offline.flushed', { success, failed, remaining: remaining.length });
  return { success, failed };
}

export function clearOfflineQueue(): void {
  const beforeDepth = readQueue().length;
  if (beforeDepth > 0) track('offline.cleared', { depth: beforeDepth });
  writeQueue([]);
}

export function subscribeToOfflineQueue(listener: Listener): () => void {
  listeners.add(listener);
  // dispara estado atual imediatamente
  listener(readQueue().length);
  return () => {
    listeners.delete(listener);
  };
}
