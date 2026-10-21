import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeExtractedSpec } from '@/lib/knowledge-base/specs-types';
import type { ResultadoExtracao } from '@/lib/knowledge-base/aprovacao-fila';

/**
 * Busca rascunhos `status='ready'` de `kb_extraction_drafts` e os converte em
 * `ResultadoExtracao[]`, que é o formato consumido por `mesclarResultados` e
 * `particionarResultados`.
 *
 * Retorna também `readyIds` — Set de document_ids com rascunho pronto, usado por
 * `docsParaExtrair` para saber quais docs já foram extraídos e não precisam de nova
 * chamada à edge function.
 *
 * Revalidação: a query invalida via `['kb-extraction-drafts']` — quem chama
 * `useBulkApproveSpecs` ou salva via `KbSpecsForm` deve invalidar essa chave.
 */
export function useExtractionDrafts(): {
  drafts: ResultadoExtracao[];
  readyIds: Set<string>;
  isLoading: boolean;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ['kb-extraction-drafts'],
    queryFn: async (): Promise<ResultadoExtracao[]> => {
      // ⚠️ coluna SINGULAR `spec` (= migration 20260613160000 + a edge). NÃO `specs`.
      const { data, error } = await supabase
        .from('kb_extraction_drafts')
        .select('document_id, spec')
        .eq('status', 'ready')
        .not('spec', 'is', null);

      if (error) throw error;

      // `spec` é `jsonb` (tipado `Json`); `normalizeExtractedSpec` é o leitor defensivo dele.
      return (data ?? [])
        .filter((row) => row.spec != null)
        .map((row) => ({
          documentId: row.document_id,
          spec: normalizeExtractedSpec(row.spec as Parameters<typeof normalizeExtractedSpec>[0]),
        }));
    },
    staleTime: 60_000,
  });

  const drafts = query.data ?? [];
  const readyIds = new Set(drafts.map((d) => d.documentId));

  return {
    drafts,
    readyIds,
    isLoading: query.isLoading,
    refetch: () => { void query.refetch(); },
  };
}
