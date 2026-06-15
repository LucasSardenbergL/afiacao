import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export interface ItemCockpitInput { empresa: string; codigo: number; preco: number; tint_formula_id?: string | null; }
export interface LinhaCockpit {
  codigo: number; empresa: string;
  faixa: 'vermelho' | 'amarelo' | 'verde' | 'neutro';
  motivo: string; tem_custo: boolean; tem_politica: boolean; calculated_at: string;
  cmc: number | null; markup_perc: number | null; folga_reais: number | null;
  piso_markup: number | null; meta_markup: number | null;
  proveniencia: string | null; frescor: string | null;
}

/** Mapa codigo→linha. Falha do cockpit NÃO derruba o wizard (cockpit é informativo). */
export function usePrecoCockpit(itens: ItemCockpitInput[]) {
  // #3 (Codex P1): o uid real entra no queryKey pra o cache de markup/folga NÃO
  // vazar entre usuários no mesmo browser (logout do gestor → login de vendedora).
  // useAuth() é SEMPRE o usuário real (identidade), nunca a lente "Ver como".
  const { user } = useAuth();
  return useQuery({
    queryKey: ['preco-cockpit', user?.id ?? 'anon', itens],
    enabled: itens.length > 0,
    staleTime: 60_000,
    // Retorna o array NA ORDEM do input (1 linha por item). Quem chama casa por
    // índice/chave — o tint repete o mesmo codigo com formulas diferentes, então
    // um Map por codigo colapsaria (por isso não mapeamos aqui).
    queryFn: async (): Promise<LinhaCockpit[]> => {
      // RPC nova ainda não está em types.ts (Lovable regenera pós-migration; NÃO adicionar à mão).
      const { data, error } = await (supabase.rpc as never as (
        fn: string, args: { p_itens: ItemCockpitInput[] }
      ) => Promise<{ data: LinhaCockpit[] | null; error: unknown }>)('get_preco_cockpit', { p_itens: itens });
      if (error) throw error;
      return (data as LinhaCockpit[]) ?? [];
    },
  });
}

/** Chave estável p/ casar uma linha do cockpit (tint repete codigo por cor). */
export function chaveCockpit(empresa: string, codigo: number, tintFormulaId?: string | null): string {
  return `${empresa}:${codigo}:${tintFormulaId ?? ''}`;
}
