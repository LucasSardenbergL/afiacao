import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { KbDocument } from '@/lib/knowledge-base/types';

/**
 * Retorna os documentos prontos (status='ready') que ainda NÃO têm ficha técnica
 * aprovada vinculada — ou seja, a "fila de aprovação" de boletins a processar.
 *
 * Estratégia:
 *  1. Busca todos os documentos com status='ready' (até 500, mais recentes primeiro).
 *  2. Busca os source_document_ids de `kb_product_spec_versions` (versões imutáveis).
 *     Anti-join via versões (não via kb_product_specs.document_id) para evitar o
 *     "queue-thrash": re-aprovar o mesmo product_code com um novo documento sobrescrevia
 *     o document_id atual, fazendo o documento antigo voltar à fila. Com versões, qualquer
 *     documento que já gerou ao menos 1 versão sai permanentemente da fila.
 *  3. Exclui em memória os já aprovados → evita join complexo ou view nova no banco.
 *
 * Cast `as any` porque kb_product_spec_versions ainda não está em types.ts
 * (Lovable regenera após apply da migration). NÃO adicionar ao types.ts à mão — lição §10.
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

      // Passo 2 — quais document_ids já geraram ao menos uma versão aprovada.
      // Lê kb_product_spec_versions (tabela imutável de versões) em vez de kb_product_specs.document_id
      // (que seria sobrescrito ao re-aprovar o mesmo product_code com outro boletim).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: aprovados, error: e2 } = await (supabase.from('kb_product_spec_versions' as any) as any)
        .select('source_document_id')
        .not('source_document_id', 'is', null);

      if (e2) throw e2;

      // Passo 3 — filtra em memória os que ainda precisam de aprovação
      const aprovadosSet = new Set(
        (aprovados ?? []).map((r: { source_document_id: string }) => r.source_document_id),
      );
      return (docs ?? []).filter((d) => !aprovadosSet.has(d.id)) as KbDocument[];
    },
  });
}
