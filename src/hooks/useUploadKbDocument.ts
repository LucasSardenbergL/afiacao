import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import type { KbDocumentType } from '@/lib/knowledge-base/types';

interface UploadInput {
  file: File;
  title: string;
  type: KbDocumentType;
  supplier?: string;
  product_code?: string;
  tags?: string[];
}

export function useUploadKbDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UploadInput) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      const safeName = input.file.name.replace(/[^\w.-]/g, '_');
      const path = `${user.id}/${Date.now()}_${safeName}`;

      // 1. Upload pro Storage
      const { error: upErr } = await supabase.storage
        .from('knowledge-base')
        .upload(path, input.file, { contentType: input.file.type || 'application/pdf' });
      if (upErr) throw upErr;

      // 2. Insert document
      const { data: doc, error: insErr } = await supabase.from('kb_documents')
        .insert({
          title: input.title,
          type: input.type,
          supplier: input.supplier ?? null,
          product_code: input.product_code ?? null,
          file_url: path,
          file_size_bytes: input.file.size,
          tags: input.tags ?? [],
          status: 'processing',
          created_by: user.id,
        })
        .select('id')
        .single();
      if (insErr) throw insErr;

      // 3. Invoca edge function (fire-and-forget — UI atualizada por polling do status)
      invokeFunction('kb-ingest-document', { documentId: doc.id }).catch((err) => {
        console.error('[useUploadKbDocument] ingest invoke failed:', err);
      });

      return doc.id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb-documents'] });
      toast.success('Documento enviado', { description: 'Processando texto e embeddings…' });
    },
    onError: (err) => {
      toast.error('Erro no upload', { description: err instanceof Error ? err.message : '' });
    },
  });
}
