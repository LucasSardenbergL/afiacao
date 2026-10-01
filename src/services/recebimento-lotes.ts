import { supabase } from '@/integrations/supabase/client';

export interface LoteEscaneado {
  id: string;
  nfe_recebimento_item_id: string;
  numero_lote: string;
  data_fabricacao: string | null;
  data_validade: string | null;
}

/**
 * Lotes escaneados de UMA NF-e.
 *
 * `nfe_lotes_escaneados` não tem coluna da NF-e: o lote liga ao ITEM (`nfe_recebimento_item_id`),
 * e o item à NF-e — por isso o filtro vai pelo embed `!inner` do item. A leitura antiga filtrava
 * por `nfe_recebimento_id` (inexistente): o PostgREST respondia 42703 e a conferência ficava sem
 * lotes, calada atrás de um `as unknown as` que curto-circuitava o tipo.
 */
export async function listarLotesEscaneados(nfeId: string): Promise<LoteEscaneado[]> {
  const { data, error } = await supabase
    .from('nfe_lotes_escaneados')
    .select(
      'id, nfe_recebimento_item_id, numero_lote, data_fabricacao, data_validade, nfe_recebimento_itens!inner(nfe_recebimento_id)',
    )
    .eq('nfe_recebimento_itens.nfe_recebimento_id', nfeId);
  if (error) throw error;
  return (data ?? []).map((l) => ({
    id: l.id,
    nfe_recebimento_item_id: l.nfe_recebimento_item_id,
    numero_lote: l.numero_lote,
    data_fabricacao: l.data_fabricacao,
    data_validade: l.data_validade,
  }));
}
