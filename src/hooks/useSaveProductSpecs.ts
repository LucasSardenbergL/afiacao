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

      const payload = {
        ...input.specs,
        document_id: input.documentId ?? null,
        extracted_by: user.id,
        approved_by: user.id,
        approved_at: new Date().toISOString(),
      };

      const { data, error } = await supabase.from('kb_product_specs')
        .upsert(payload, { onConflict: 'product_code' })
        .select()
        .single();

      if (error) throw error;
      return data as KbProductSpec;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['kb-product-specs'] });
      qc.invalidateQueries({ queryKey: ['kb-product-spec', data.product_code] });
      toast.success('Specs salvos', { description: `${data.product_name} (${data.product_code})` });
    },
    onError: (err) => {
      toast.error('Erro ao salvar', { description: err instanceof Error ? err.message : '' });
    },
  });
}
