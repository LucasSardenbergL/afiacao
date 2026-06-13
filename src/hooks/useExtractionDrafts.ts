import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeExtractedSpec } from '@/lib/knowledge-base/specs-types';
import type { ResultadoExtracao } from '@/lib/knowledge-base/aprovacao-fila';

/**
 * Rascunho salvo no banco — shape do SELECT em `kb_extraction_drafts`.
 * Tabela criada na Task 1; ainda não está em types.ts (gerado automaticamente pelo Lovable).
 * Cast via `as never` / `as any` é o padrão documentado no CLAUDE.md §10.
 */
interface KbExtractionDraft {
  document_id: string;
  status: 'extracting' | 'ready' | 'failed';
  // ⚠️ coluna SINGULAR `spec` (= migration 20260613160000 + a edge). NÃO `specs`.
  spec: Record<string, unknown> | null;
}

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
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const { data, error } = await (
        supabase.from('kb_extraction_drafts' as never) as any
      )
        .select('document_id, status, spec')
        .eq('status', 'ready')
        .not('spec', 'is', null);
      /* eslint-enable @typescript-eslint/no-explicit-any */

      if (error) throw error;

      const rows: KbExtractionDraft[] = data ?? [];

      return rows
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
