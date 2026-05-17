import { useMutation } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import type { RagSearchOptions, RagSearchResult } from '@/lib/rag/types';

interface SearchInput {
  query: string;
  options?: RagSearchOptions;
}

/**
 * Mutation (não query) pra busca semântica. Mutation porque cada busca
 * é uma ação discreta com payload variável; cache só faria sentido com
 * key estável, e o consumidor (PR-P3/P4) controla quando chamar.
 */
export function useRagSearch() {
  return useMutation({
    mutationFn: async ({ query, options }: SearchInput): Promise<RagSearchResult[]> => {
      const res = await invokeFunction<{ results: RagSearchResult[] }>('rag-search', {
        query,
        top_k: options?.top_k ?? 5,
        sources: options?.sources,
        filters: options?.filters,
      });
      return res.results;
    },
  });
}
