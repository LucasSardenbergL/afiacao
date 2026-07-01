import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { KbProductSpec } from '@/lib/knowledge-base/specs-types';

/**
 * ⚠️ ADMIN-ONLY. Lê a ficha por `product_code` SEM filtrar `approved_at` (o detalhe precisa
 * ver o rascunho não-aprovado). A VENDA/COPILOT NUNCA devem usar este hook — leem a fonte
 * única `v_omie_product_current_spec` (dupla-trava confirmed + approved_at). Ver
 * docs/superpowers/specs/2026-06-13-kb-0c-aprovacao-master-only-design.md §4e.
 */
export function useKbProductSpecs(productCode: string | undefined | null) {
  return useQuery({
    queryKey: ['kb-product-spec', productCode],
    enabled: !!productCode,
    staleTime: 60_000,
    queryFn: async (): Promise<KbProductSpec | null> => {
      if (!productCode) return null;
      const { data, error } = await supabase.from('kb_product_specs')
        .select('*')
        .eq('product_code', productCode)
        .maybeSingle();
      if (error) throw error;
      return (data as KbProductSpec) ?? null;
    },
  });
}

/**
 * ⚠️ ADMIN-ONLY. Irmão de `useKbProductSpecs`, mas liga pela FK REAL `document_id` — não pelo
 * `product_code` denormalizado do documento, que nasce NULL no upload/extração e nunca é carimbado
 * de volta, escondendo os painéis do detalhe (Specs/vínculo base/Catalisador). O detalhe do boletim
 * SEMPRE tem o `document_id` (é o id da rota), então este é o vínculo confiável. Mesma ressalva de
 * segurança: NÃO filtra `approved_at` (o detalhe vê o rascunho); a VENDA/COPILOT leem
 * `v_omie_product_current_spec`.
 */
export function useKbProductSpecsByDocument(documentId: string | undefined | null) {
  return useQuery({
    queryKey: ['kb-product-spec-by-doc', documentId],
    enabled: !!documentId,
    staleTime: 60_000,
    queryFn: async (): Promise<KbProductSpec | null> => {
      if (!documentId) return null;
      // .order+.limit(1): document_id NÃO tem constraint unique (só product_code tem). Hoje é 1:1,
      // mas se uma re-extração deixar rascunho + aprovada no mesmo doc, um .maybeSingle() cru
      // estouraria (PGRST116) e quebraria a tela. Ordenar por approved_at desc pega a ficha "atual"
      // (aprovada > rascunho) e limitar a 1 mantém o maybeSingle sempre seguro.
      const { data, error } = await supabase.from('kb_product_specs')
        .select('*')
        .eq('document_id', documentId)
        .order('approved_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as KbProductSpec) ?? null;
    },
  });
}
