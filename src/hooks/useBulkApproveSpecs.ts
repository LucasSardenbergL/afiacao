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
 * - Execução sequencial evita corridas no upsert por `product_code`.
 * - Payload idêntico ao `useSaveProductSpecs` (`extracted_by`, `approved_by`, `approved_at`).
 * - Falha em uma ficha não derruba as demais — erro é registrado e o loop segue.
 * - Ao final, invalida as queries `kb-product-specs`, `kb-approval-queue` e `kb-documents`.
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

      // Captura o ID em const tipada para satisfazer strictNullChecks no closure abaixo
      const userId: string = user.id;

      let ok = 0;
      const erros: BulkApproveResult['erros'] = [];

      // Loop sequencial: garante que o upsert por `product_code` nunca corra consigo mesmo
      for (const { documentId, spec } of resultados) {
        const payload = {
          ...spec,
          document_id: documentId,
          extracted_by: userId,
          approved_by: userId,
          approved_at: new Date().toISOString(),
        };

        const { error } = await supabase
          .from('kb_product_specs')
          .upsert(payload, { onConflict: 'product_code' });

        if (error) {
          erros.push({ documentId, error: error.message });
        } else {
          ok += 1;
        }
      }

      // Invalida as queries dependentes para que a UI reflita o novo estado
      await queryClient.invalidateQueries({ queryKey: ['kb-product-specs'] });
      await queryClient.invalidateQueries({ queryKey: ['kb-approval-queue'] });
      await queryClient.invalidateQueries({ queryKey: ['kb-documents'] });

      setIsApproving(false);
      return { ok, erros };
    },
    [queryClient],
  );

  return { isApproving, approve };
}
