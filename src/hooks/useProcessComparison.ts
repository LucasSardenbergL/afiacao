import { useMutation } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import type { ProcessComparison, LookalikeRef } from '@/lib/customer-process/comparison-types';

export interface ProcessComparisonResponse {
  analysis: ProcessComparison;
  lookalikes: LookalikeRef[];
  metadata: {
    customer_segment: string | null;
    customer_tags: string[];
    has_lookalikes: boolean;
    standards_compared: number;
    lookalikes_found: number;
  };
}

/**
 * Mutation que invoca a edge fn compare-customer-process.
 * Vendedor clica botão → Claude analisa → resposta estruturada.
 */
export function useProcessComparison() {
  return useMutation({
    mutationFn: async (customer_user_id: string): Promise<ProcessComparisonResponse> => {
      return await invokeFunction<ProcessComparisonResponse>(
        'compare-customer-process',
        { customer_user_id }
      );
    },
    onError: (err) => {
      toast.error('Erro na comparação', {
        description: err instanceof Error ? err.message : 'Falha desconhecida',
      });
    },
  });
}
