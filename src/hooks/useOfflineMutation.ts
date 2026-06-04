import { useState } from 'react';
import { useMutation, type UseMutationOptions } from '@tanstack/react-query';
import { enqueue } from '@/lib/offline-queue';

/**
 * Detecta erro de rede vs erro de aplicação. Erros de rede vão pra fila;
 * erros de validação (400/422 etc) propagam normalmente.
 */
export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  if (err instanceof TypeError && /network|fetch|failed/i.test(err.message)) return true;
  // PostgREST sem rede pode estourar genérico — checkar mensagem
  if (err instanceof Error && /networkerror|failed to fetch|load failed/i.test(err.message)) return true;
  // .rpc()/.from() do supabase devolvem `{ error: { message } }` (objeto plain, não Error) em falha de fetch.
  if (
    err && typeof err === 'object' && 'message' in err &&
    typeof (err as { message: unknown }).message === 'string' &&
    /networkerror|failed to fetch|load failed|network request failed/i.test((err as { message: string }).message)
  ) return true;
  return false;
}

export interface UseOfflineMutationOptions<TData, TVars> {
  /** Identificador estável da mutação (ex: 'recebimento.confirm-unit'). */
  kind: string;
  /** Função executada online. */
  mutationFn: (vars: TVars) => Promise<TData>;
  /** Callbacks opcionais (passa direto pro useMutation). */
  onSuccess?: UseMutationOptions<TData, Error, TVars>['onSuccess'];
  onError?: UseMutationOptions<TData, Error, TVars>['onError'];
}

export interface UseOfflineMutationReturn<TData, TVars> {
  mutateAsync: (vars: TVars) => Promise<TData | null>;
  isPending: boolean;
  /** True quando última chamada caiu na fila offline. */
  queued: boolean;
  /** Limpa flag queued (UI reset). */
  resetQueued: () => void;
}

/**
 * Envolve useMutation com fallback offline: se navigator.onLine === false
 * OU mutationFn falha com erro de rede, chama `enqueue(kind, variables)`.
 * Retorna `null` quando enfileira (caller decide UX).
 *
 * Padrão de uso:
 *   const m = useOfflineMutation({
 *     kind: 'recebimento.confirm-unit',
 *     mutationFn: async (vars) => supabase.from('nfe_recebimentos').update(...).eq('id', vars.id),
 *   });
 *   const r = await m.mutateAsync({ id, status });
 *   if (m.queued) toast.info('Salvo offline — vai sincronizar quando conectar');
 */
export function useOfflineMutation<TData, TVars>({
  kind,
  mutationFn,
  onSuccess,
  onError,
}: UseOfflineMutationOptions<TData, TVars>): UseOfflineMutationReturn<TData, TVars> {
  const [queued, setQueued] = useState(false);

  const mutation = useMutation<TData, Error, TVars>({
    mutationFn,
    onSuccess,
    onError,
  });

  const mutateAsync = async (vars: TVars): Promise<TData | null> => {
    // 1. Offline imediato → enfileira sem nem tentar
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await enqueue(kind, vars);
      setQueued(true);
      return null;
    }

    // 2. Online → tenta. Cai pra fila se erro de rede.
    try {
      setQueued(false);
      return await mutation.mutateAsync(vars);
    } catch (err) {
      if (isNetworkError(err)) {
        await enqueue(kind, vars);
        setQueued(true);
        return null;
      }
      throw err;
    }
  };

  return {
    mutateAsync,
    isPending: mutation.isPending,
    queued,
    resetQueued: () => setQueued(false),
  };
}
