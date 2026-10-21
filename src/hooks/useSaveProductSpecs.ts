import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { KbExtractedSpec, KbProductSpec } from '@/lib/knowledge-base/specs-types';
import { comNulo } from '@/lib/rpc-args';

interface SaveInput {
  specs: KbExtractedSpec;
  documentId?: string;
  /** Default 'bulletin_revision' (aprovação de boletim). B2 passa 'correction'/'data_completion'. */
  changeType?: 'bulletin_revision' | 'correction' | 'data_completion';
  /** Obrigatória (server-side) quando changeType é correction/data_completion. */
  changeNote?: string | null;
}

export function useSaveProductSpecs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveInput): Promise<KbProductSpec> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      // Aprovação passa pela RPC transacional (grava versão imutável + atualiza atual + deleta rascunho).
      // NÃO incluir document_id/approved_at/approved_by/extracted_by no p_payload — a RPC seta server-side.
      // `p_document_id` NULL = ficha editada sem documento de origem; `p_change_note` NULL = sem nota
      // (DEFAULT NULL). Os dois vão explícitos, como antes.
      const { error } = await supabase.rpc(
        'aprovar_versao_boletim',
        comNulo<'aprovar_versao_boletim', 'p_document_id' | 'p_change_note'>({
          p_payload: input.specs,
          p_document_id: input.documentId ?? null,
          p_change_type: input.changeType ?? 'bulletin_revision',
          p_change_note: input.changeNote ?? null,
        }),
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
