import { useMutation } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';
import { normalizeExtractedSpec } from '@/lib/knowledge-base/specs-types';

interface ExtractResponse {
  specs: KbExtractedSpec;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
}

export function useExtractSpecs() {
  return useMutation({
    mutationFn: async (documentId: string): Promise<ExtractResponse> => {
      const response = await invokeFunction<ExtractResponse>('kb-extract-specs', { documentId });
      return { ...response, specs: normalizeExtractedSpec(response.specs) };
    },
    onError: (err) => {
      toast.error('Erro na extração', { description: err instanceof Error ? err.message : '' });
    },
  });
}
