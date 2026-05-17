import { useMutation } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import type { RagSource } from '@/lib/rag/types';

interface ReindexInput {
  source_table: RagSource;
  source_id: string;
}

/**
 * Mutation fire-and-forget pra reindexar uma fonte no rag_chunks.
 * Hooks de save (useSaveCustomerProcess, useSaveStandardProcess) chamam isso
 * no onSuccess via `reindex.mutate(...)` sem await.
 *
 * Erros não interrompem o flow do save — logam console.error.
 */
export function useReindexRag() {
  return useMutation({
    mutationFn: async (input: ReindexInput): Promise<void> => {
      await invokeFunction('rag-reindex', input);
    },
    onError: (err, input) => {
      console.error('[useReindexRag] failed for', input, err);
    },
  });
}
