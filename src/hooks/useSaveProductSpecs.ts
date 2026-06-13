import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { KbExtractedSpec, KbProductSpec } from '@/lib/knowledge-base/specs-types';

interface SaveInput {
  specs: KbExtractedSpec;
  documentId?: string;
}

export function useSaveProductSpecs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveInput): Promise<KbProductSpec> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      // Aprovação passa pela RPC transacional (grava versão imutável + atualiza atual + deleta rascunho).
      // NÃO incluir document_id/approved_at/approved_by/extracted_by no p_payload — a RPC seta server-side.
      // Cast `as never` no nome: aprovar_versao_boletim ainda não está em types.ts
      // (Lovable regenera após apply da migration). NÃO adicionar à mão — lição §10.
      const { error } = await supabase.rpc(
        'aprovar_versao_boletim' as never,
        {
          p_payload: input.specs,
          p_document_id: input.documentId ?? null,
          p_change_type: 'bulletin_revision',
          p_change_note: null,
        } as never,
      );

      if (error) throw new Error(error.message);

      // Recarrega a spec aprovada para retornar como KbProductSpec
      const { data: spec, error: e2 } = await supabase
        .from('kb_product_specs')
        .select('*')
        .eq('product_code', input.specs.product_code)
        .single();

      if (e2) throw e2;

      return spec as KbProductSpec;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['kb-product-specs'] });
      qc.invalidateQueries({ queryKey: ['kb-product-spec', data.product_code] });
      qc.invalidateQueries({ queryKey: ['kb-approval-queue'] });
      qc.invalidateQueries({ queryKey: ['kb-documents'] });
      qc.invalidateQueries({ queryKey: ['kb-extraction-drafts'] });
      qc.invalidateQueries({ queryKey: ['kb-spec-versions'] });
      toast.success('Specs salvos', { description: `${data.product_name} (${data.product_code})` });
    },
    onError: (err) => {
      toast.error('Erro ao salvar', { description: err instanceof Error ? err.message : '' });
    },
  });
}
