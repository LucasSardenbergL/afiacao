import { supabase } from '@/integrations/supabase/client';
import type { TablesUpdate } from '@/integrations/supabase/types';

export interface ReportDivergenciaVars {
  itemId: string;
  nfeId: string;
  /**
   * Texto do conferente, gravado em `observacao_divergencia`. O NOME deste campo é contrato da
   * fila persistida (`offline_queue_v1` guarda as vars em JSON): renomeá-lo deixaria órfão o que
   * já estiver enfileirado.
   */
  observacao: string;
}

/**
 * Encapsula as 2 mutations de `handleReportDivergencia` numa operação
 * idempotente o suficiente pra processar offline-then-online.
 *
 * Notas de idempotência:
 * - UPDATE de status_item + observacao_divergencia usa valor absoluto, rodar 2x não causa
 *   efeito colateral.
 * - UPDATE de status do NF-e idem (valor absoluto 'divergencia').
 *
 * `satisfies TablesUpdate<…>`: o `update` do postgrest-js é genérico (`Row extends Update`), e
 * literal com ao menos UMA coluna válida passa no typecheck carregando coluna inexistente — foi
 * assim que `observacao` (a tabela só tem `observacao_divergencia`) virou PGRST204 em runtime.
 * O `satisfies` devolve a checagem de propriedade excedente.
 */
export async function reportDivergencia(vars: ReportDivergenciaVars): Promise<{ ok: true }> {
  const { error: e1 } = await supabase
    .from('nfe_recebimento_itens')
    .update({
      status_item: 'divergencia',
      observacao_divergencia: vars.observacao,
    } satisfies TablesUpdate<'nfe_recebimento_itens'>)
    .eq('id', vars.itemId);
  if (e1) throw e1;

  const { error: e2 } = await supabase
    .from('nfe_recebimentos')
    .update({ status: 'divergencia' } satisfies TablesUpdate<'nfe_recebimentos'>)
    .eq('id', vars.nfeId);
  if (e2) throw e2;

  return { ok: true };
}
