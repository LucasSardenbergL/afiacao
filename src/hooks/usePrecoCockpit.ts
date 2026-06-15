import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

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
  return useQuery({
    queryKey: ['preco-cockpit', itens],
    enabled: itens.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<number, LinhaCockpit>> => {
      // RPC nova ainda não está em types.ts (Lovable regenera pós-migration; NÃO adicionar à mão).
      const { data, error } = await (supabase.rpc as never as (
        fn: string, args: { p_itens: ItemCockpitInput[] }
      ) => Promise<{ data: LinhaCockpit[] | null; error: unknown }>)('get_preco_cockpit', { p_itens: itens });
      if (error) throw error;
      const m = new Map<number, LinhaCockpit>();
      for (const l of (data as LinhaCockpit[]) ?? []) m.set(l.codigo, l);
      return m;
    },
  });
}
