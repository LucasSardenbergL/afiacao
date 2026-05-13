import { useMutation, useQueryClient, type UseMutationOptions, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';

/**
 * Wrapper sobre useMutation com optimistic update + rollback padronizados.
 *
 * Princípio do projeto: latência percebida <100ms em operações críticas (scan, picking,
 * recebimento, cart). Esta API obriga a pensar em onMutate/onError de forma simétrica.
 *
 * Uso:
 *   const m = useOptimisticMutation({
 *     mutationFn: (item) => supabase.from('foo').insert(item),
 *     queryKey: ['foo-list', filtros],
 *     optimisticUpdate: (prev: Item[] | undefined, item) => [...(prev ?? []), item],
 *     successToast: 'Item adicionado',
 *     errorToast: 'Não foi possível adicionar',
 *   });
 *
 *   m.mutate(item);  // UI atualiza instantaneamente; rollback se servidor recusar.
 */
interface OptimisticMutationOptions<TData, TVariables, TCache>
  extends Omit<UseMutationOptions<TData, Error, TVariables, { previous: TCache | undefined }>,
    'onMutate' | 'onError' | 'onSettled'
  > {
  /** Chave do cache react-query a ser modificada otimisticamente. */
  queryKey: QueryKey;
  /**
   * Função pura que recebe o cache anterior + variáveis da mutação e retorna o novo cache.
   * Pode retornar undefined para apagar o cache (uso raro).
   */
  optimisticUpdate: (previous: TCache | undefined, variables: TVariables) => TCache | undefined;
  /** Mensagem de sucesso (string) ou função que recebe o resultado. Opcional. */
  successToast?: string | ((data: TData, variables: TVariables) => string);
  /** Mensagem de erro (string) ou função que recebe o erro. Opcional. */
  errorToast?: string | ((err: Error, variables: TVariables) => string);
  /** Outras chaves a invalidar após sucesso. */
  invalidate?: QueryKey[];
}

export function useOptimisticMutation<TData, TVariables, TCache = unknown>(
  options: OptimisticMutationOptions<TData, TVariables, TCache>,
) {
  const qc = useQueryClient();
  const {
    queryKey,
    optimisticUpdate,
    successToast,
    errorToast,
    invalidate,
    mutationFn,
    ...rest
  } = options;

  return useMutation<TData, Error, TVariables, { previous: TCache | undefined }>({
    ...rest,
    mutationFn,
    onMutate: async (variables) => {
      // 1. cancela queries em voo para a chave (evita race com refetch)
      await qc.cancelQueries({ queryKey });
      // 2. snapshot do cache atual
      const previous = qc.getQueryData<TCache>(queryKey);
      // 3. aplica update otimista
      qc.setQueryData<TCache>(queryKey, (old) => optimisticUpdate(old, variables));
      return { previous };
    },
    onError: (err, variables, context) => {
      // rollback
      if (context && context.previous !== undefined) {
        qc.setQueryData(queryKey, context.previous);
      }
      logger.error('useOptimisticMutation: erro na mutação, rollback aplicado', {
        queryKey: JSON.stringify(queryKey),
        error: err.message,
      });
      const msg =
        typeof errorToast === 'function'
          ? errorToast(err, variables)
          : (errorToast ?? 'Não foi possível concluir a operação');
      toast.error(msg, { description: err.message });
    },
    onSuccess: (data, variables, context) => {
      const msg =
        typeof successToast === 'function'
          ? successToast(data, variables)
          : successToast;
      if (msg) toast.success(msg);
      rest.onSuccess?.(data, variables, context as { previous: TCache | undefined });
    },
    onSettled: () => {
      // refetch para garantir estado consistente após sucesso ou rollback
      qc.invalidateQueries({ queryKey });
      invalidate?.forEach((k) => qc.invalidateQueries({ queryKey: k }));
    },
  });
}
