import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { KbDocument } from '@/lib/knowledge-base/types';

/**
 * Retorna os documentos prontos (status='ready') que ainda NÃO têm ficha técnica
 * aprovada vinculada — ou seja, a "fila de aprovação" de boletins a processar.
 *
 * Estratégia:
 *  1. Busca todos os documentos com status='ready' (até 500, mais recentes primeiro).
 *  2. Busca os document_ids que já têm ao menos uma spec com approved_at preenchido.
 *  3. Exclui em memória os já aprovados → evita join complexo ou view nova no banco.
 */
export function useApprovalQueue() {
  return useQuery({
    queryKey: ['kb-approval-queue'],
    staleTime: 30_000,
    queryFn: async (): Promise<KbDocument[]> => {
      // Passo 1 — documentos prontos
      const { data: docs, error: e1 } = await supabase
        .from('kb_documents')
        .select('*')
        .eq('status', 'ready')
        .order('created_at', { ascending: false })
        .limit(500);

      if (e1) throw e1;

      // Passo 2 — quais document_ids já têm spec aprovada
      const { data: approved, error: e2 } = await supabase
        .from('kb_product_specs')
        .select('document_id')
        .not('approved_at', 'is', null)
        .not('document_id', 'is', null);

      if (e2) throw e2;

      // Passo 3 — filtra em memória os que ainda precisam de aprovação
      const aprovados = new Set((approved ?? []).map((r) => r.document_id as string));
      return (docs ?? []).filter((d) => !aprovados.has(d.id)) as KbDocument[];
    },
  });
}
