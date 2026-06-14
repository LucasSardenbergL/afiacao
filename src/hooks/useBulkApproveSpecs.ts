import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { ResultadoExtracao } from '@/lib/knowledge-base/aprovacao-fila';

/** Resultado agregado da aprovação em lote. */
export interface BulkApproveResult {
  /** Quantidade de fichas salvas com sucesso. */
  ok: number;
  /** Documentos que falharam ao salvar, com mensagem de erro. */
  erros: { documentId: string; error: string }[];
}

/**
 * Aprova (persiste) várias fichas técnicas em lote de forma **sequencial**.
 *
 * - Execução sequencial evita corridas na RPC por `product_code` (advisory lock server-side).
 * - Aprovação passa pela RPC `aprovar_versao_boletim` (grava versão imutável + atualiza atual
 *   + deleta rascunho de kb_extraction_drafts — tudo numa transação).
 * - NÃO inclui document_id/approved_at/approved_by/extracted_by no p_payload: a RPC seta server-side.
 * - `deleteDraft` foi REMOVIDO: a RPC cuida da limpeza do rascunho transacionalmente
 *   (nota de RECONCILIAÇÃO com PR #802 no plano de versionamento).
 * - Falha em uma ficha não derruba as demais — erro é registrado e o loop segue.
 * - Ao final, invalida as queries `kb-product-specs`, `kb-approval-queue`, `kb-documents`,
 *   `kb-extraction-drafts` e `kb-spec-versions`.
 */
export function useBulkApproveSpecs(): {
  isApproving: boolean;
  approve: (resultados: ResultadoExtracao[]) => Promise<BulkApproveResult>;
} {
  const [isApproving, setIsApproving] = useState(false);
  const queryClient = useQueryClient();

  const approve = useCallback(
    async (resultados: ResultadoExtracao[]): Promise<BulkApproveResult> => {
      setIsApproving(true);

      // Obtém o usuário autenticado uma única vez para o lote inteiro
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setIsApproving(false);
        throw new Error('Não autenticado');
      }

      let ok = 0;
      const erros: BulkApproveResult['erros'] = [];

      // Loop sequencial: garante que a RPC por `product_code` nunca corra consigo mesma.
      // Cast `as never` no nome da RPC: aprovar_versao_boletim ainda não está em types.ts
      // (Lovable regenera após apply da migration). NÃO adicionar ao types.ts à mão — lição §10.
      for (const { documentId, spec } of resultados) {
        const { error } = await supabase.rpc(
          'aprovar_versao_boletim' as never,
          {
            p_payload: spec,
            p_document_id: documentId,
            p_change_type: 'bulletin_revision',
            p_change_note: null,
          } as never,
        );

        if (error) {
          erros.push({ documentId, error: error.message });
        } else {
          ok += 1;
        }
      }

      // Invalida as queries dependentes para que a UI reflita o novo estado.
      // kb-extraction-drafts: a RPC deleta transacionalmente, mas a UI precisa refrescar.
      await queryClient.invalidateQueries({ queryKey: ['kb-product-specs'] });
      await queryClient.invalidateQueries({ queryKey: ['kb-approval-queue'] });
      await queryClient.invalidateQueries({ queryKey: ['kb-documents'] });
      await queryClient.invalidateQueries({ queryKey: ['kb-extraction-drafts'] });
      await queryClient.invalidateQueries({ queryKey: ['kb-spec-versions'] });

      setIsApproving(false);
      return { ok, erros };
    },
    [queryClient],
  );

  return { isApproving, approve };
}
