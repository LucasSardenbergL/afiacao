import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { relatorioCompletude, type CompletudeProduto } from '@/lib/knowledge-base/completude';
import type { KbProductSpec } from '@/lib/knowledge-base/specs-types';

export interface CompletudeProdutoComDoc extends CompletudeProduto {
  document_id: string | null;
}

/**
 * Produtos APROVADOS com campos importantes faltando — a lista de "o que pedir à fábrica"
 * (Fase B1). Ordenado do mais incompleto pro menos; produto completo NÃO aparece.
 *
 * Volume pequeno (~119 fichas aprovadas) → sem paginação. Se passar de 1000 vira follow-up.
 */
export function useCompletude() {
  return useQuery({
    queryKey: ['kb-completude'],
    staleTime: 60_000,
    queryFn: async (): Promise<CompletudeProdutoComDoc[]> => {
      const { data, error } = await supabase
        .from('kb_product_specs')
        .select('*')
        .not('approved_at', 'is', null);
      if (error) throw error;
      const rows = (data ?? []) as KbProductSpec[];
      const docById = new Map(rows.map((r) => [r.product_code, r.document_id]));
      return relatorioCompletude(rows)
        .filter((p) => p.faltantes.length > 0)
        .map((p) => ({ ...p, document_id: docById.get(p.product_code) ?? null }));
    },
  });
}
