// A gravação de UM item de promoção (edição inline, desconto extra, vínculo manual).
import { supabase } from "@/integrations/supabase/client";
import type { ItemRow } from "./types";

/**
 * Só é sucesso se EXATAMENTE uma linha mudou. O PostgREST responde 204 sem erro a um PATCH que não
 * casa nada (item excluído depois que a tela carregou, ou escondido pela RLS); sem esta conferência
 * o vínculo manual seguia, inserindo irmãos e anunciando "vinculado" sobre um original inexistente.
 */
export async function atualizarItemPromocao(itemId: number, changes: Partial<ItemRow>): Promise<void> {
  const { data, error } = await supabase
    .from("promocao_item")
    .update(changes as never)
    .eq("id", itemId)
    .select("id");
  if (error) throw error;
  const linhas = (data as unknown[] | null)?.length ?? 0;
  if (linhas !== 1) {
    throw new Error(`Item ${itemId}: nenhuma linha gravada (${linhas}) — recarregue a campanha; ele pode ter sido removido`);
  }
}
