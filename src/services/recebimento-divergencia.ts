import { supabase } from '@/integrations/supabase/client';

export interface ReportDivergenciaVars {
  itemId: string;
  nfeId: string;
  observacao: string;
}

/**
 * Encapsula as 2 mutations de `handleReportDivergencia` numa operação
 * idempotente o suficiente pra processar offline-then-online.
 *
 * Notas de idempotência:
 * - UPDATE de status_item + observacao usa valor absoluto, rodar 2x não causa
 *   efeito colateral.
 * - UPDATE de status do NF-e idem (valor absoluto 'divergencia').
 */
export async function reportDivergencia(vars: ReportDivergenciaVars): Promise<{ ok: true }> {
  const { error: e1 } = await supabase
    .from('nfe_recebimento_itens')
    .update({ status_item: 'divergencia', observacao: vars.observacao })
    .eq('id', vars.itemId);
  if (e1) throw e1;

  const { error: e2 } = await supabase
    .from('nfe_recebimentos')
    .update({ status: 'divergencia' })
    .eq('id', vars.nfeId);
  if (e2) throw e2;

  return { ok: true };
}
