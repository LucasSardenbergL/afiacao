import { useMutation } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';
import { normalizeExtractedSpec } from '@/lib/knowledge-base/specs-types';

interface ExtractResponse {
  specs?: KbExtractedSpec;
  status?: 'extracting';
  cached?: boolean;
  usage?: {
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
      // `status: 'extracting'` → claim perdido, sem spec. Retorna como-está (não chama normalize).
      if (response.status === 'extracting' || !response.specs) {
        return response;
      }
      return { ...response, specs: normalizeExtractedSpec(response.specs) };
    },
    onError: (err) => {
      toast.error('Erro na extração', { description: err instanceof Error ? err.message : '' });
    },
  });
}
