import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { normalizeProductCode } from '@/lib/knowledge-base/code-normalize';
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

/**
 * Uma versão imutável de ficha técnica (kb_product_spec_versions, Fase A).
 * Estende os campos técnicos (pro diff) com os metadados de versão.
 */
export interface SpecVersion extends Partial<KbExtractedSpec> {
  id: string;
  version_number: number;
  change_type: string;
  change_note: string | null;
  approved_at: string;
  product_code: string;
  source_document_id: string | null;
  superseded_at: string | null;
}

/**
 * Histórico de versões de um PRODUTO (identidade = supplier + product_code_normalized).
 * Ordenado da mais recente pra mais antiga (version_number DESC).
 *
 * ⚠️ Passe o `supplier`/`productCode` da FICHA APROVADA (useKbProductSpecs), não do
 * kb_documents — foi esse par que o backfill/RPC gravou na identidade.
 *
 * Cast `as any` porque kb_product_spec_versions ainda não está em types.ts
 * (Lovable regenera após apply da migration). NÃO adicionar ao types.ts à mão — lição §10.
 */
export function useSpecVersions(
  supplier: string | null | undefined,
  productCode: string | null | undefined,
) {
  const norm = normalizeProductCode(productCode);
  const sup = (supplier ?? 'sayerlack').toLowerCase().trim();
  return useQuery({
    queryKey: ['kb-spec-versions', sup, norm],
    enabled: !!norm,
    staleTime: 60_000,
    queryFn: async (): Promise<SpecVersion[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('kb_product_spec_versions' as any) as any)
        .select('*')
        .eq('supplier', sup)
        .eq('product_code_normalized', norm)
        .order('version_number', { ascending: false });
      if (error) throw error;
      return (data ?? []) as SpecVersion[];
    },
  });
}
