import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invokeFunction } from '@/lib/invoke-function';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface BatchUploadItem {
  file: File;
  status: 'pendente' | 'enviando' | 'ok' | 'erro';
  error?: string;
}

export interface BatchUploadInput {
  files: File[];
  supplier?: string;
  tags?: string[];
}

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Quantos uploads rodam em paralelo ao mesmo tempo. */
const CONCORRENCIA = 3;

// ─── Helpers internos ────────────────────────────────────────────────────────

/** Remove a extensão .pdf (case-insensitive) do nome do arquivo. */
function titleFromFileName(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

/** Replica exatamente a lógica de upload de 1 arquivo do useUploadKbDocument. */
async function uploadOne(
  file: File,
  opts: { userId: string; supplier?: string; tags?: string[] },
): Promise<void> {
  const safeName = file.name.replace(/[^\w.-]/g, '_');
  const path = `${opts.userId}/${Date.now()}_${safeName}`;

  // 1. Upload pro Storage
  const { error: upErr } = await supabase.storage
    .from('knowledge-base')
    .upload(path, file, { contentType: file.type || 'application/pdf' });
  if (upErr) throw upErr;

  // 2. Insert em kb_documents (status='processing')
  const { data: doc, error: insErr } = await supabase
    .from('kb_documents')
    .insert({
      title: titleFromFileName(file.name),
      type: 'boletim_tecnico',
      supplier: opts.supplier ?? null,
      product_code: null, // a IA extrai na etapa de aprovação
      file_url: path,
      file_size_bytes: file.size,
      tags: opts.tags ?? [],
      status: 'processing',
      created_by: opts.userId,
    })
    .select('id')
    .single();
  if (insErr) throw insErr;

  // 3. Dispara a edge function (fire-and-forget — polling de status cuida do resto)
  invokeFunction('kb-ingest-document', { documentId: doc.id }).catch((err) => {
    console.error('[useBatchUploadKbDocuments] ingest invoke falhou:', err);
  });
}

// ─── Hook público ────────────────────────────────────────────────────────────

export function useBatchUploadKbDocuments(): {
  items: BatchUploadItem[];
  isRunning: boolean;
  run: (input: BatchUploadInput) => Promise<void>;
  reset: () => void;
} {
  const qc = useQueryClient();
  const [items, setItems] = useState<BatchUploadItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  /** Atualiza o status de um item pelo índice. */
  const setItemStatus = useCallback(
    (index: number, status: BatchUploadItem['status'], error?: string) => {
      setItems((prev) =>
        prev.map((item, i) =>
          i === index ? { ...item, status, error } : item,
        ),
      );
    },
    [],
  );

  const run = useCallback(
    async (input: BatchUploadInput) => {
      if (isRunning) return;

      // Inicializa todos os itens como 'pendente'
      const initialItems: BatchUploadItem[] = input.files.map((file) => ({
        file,
        status: 'pendente',
      }));
      setItems(initialItems);
      setIsRunning(true);

      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Não autenticado');

        // Captura o ID fora do worker para evitar problema de narrowing no closure
        const userId = user.id;

        // Pool de concorrência: índice compartilhado entre N workers
        let nextIndex = 0;

        async function worker() {
          while (true) {
            const index = nextIndex++;
            if (index >= input.files.length) break;

            const file = input.files[index];
            setItemStatus(index, 'enviando');

            try {
              await uploadOne(file, {
                userId,
                supplier: input.supplier,
                tags: input.tags,
              });
              setItemStatus(index, 'ok');
            } catch (err) {
              const msg =
                err instanceof Error ? err.message : 'Erro desconhecido';
              setItemStatus(index, 'erro', msg);
            }
          }
        }

        // Dispara CONCORRENCIA workers em paralelo; cada um consome do índice compartilhado
        await Promise.all(
          Array.from({ length: Math.min(CONCORRENCIA, input.files.length) }, () =>
            worker(),
          ),
        );
      } finally {
        setIsRunning(false);
        // Invalida as queries independentemente de sucesso/falha parcial
        qc.invalidateQueries({ queryKey: ['kb-documents'] });
        qc.invalidateQueries({ queryKey: ['kb-approval-queue'] });
      }
    },
    [isRunning, qc, setItemStatus],
  );

  const reset = useCallback(() => {
    setItems([]);
  }, []);

  return { items, isRunning, run, reset };
}
