import { supabase } from '@/integrations/supabase/client';

export interface AddCteVars {
  nfeId: string;
  chaveAcesso: string;
  xmlCte: string | null;
}

/**
 * Encapsula o INSERT de `handleAddCte` no service pra ser offline-capable.
 *
 * Nota de idempotência:
 * - INSERT em cte_associados pode duplicar se a fila reprocessar (não há unique
 *   constraint por (nfe_recebimento_id, chave_acesso_cte) garantida nesta camada).
 *   Aceita pq duplicatas são detectáveis visualmente pelo conferente e o impacto
 *   é baixo (apenas listagem). Resolução futura: unique constraint no schema.
 */
export async function addCte(vars: AddCteVars): Promise<{ ok: true }> {
  const { error } = await supabase
    .from('cte_associados')
    .insert({
      nfe_recebimento_id: vars.nfeId,
      chave_acesso_cte: vars.chaveAcesso,
      xml_cte: vars.xmlCte,
      status: 'pendente',
    });
  if (error) throw error;
  return { ok: true };
}
