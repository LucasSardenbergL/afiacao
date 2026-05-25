import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { rankAPositivar } from '@/lib/positivacao/ranking';
import { pctPositivacao, pctCobertura, ticketMedio } from '@/lib/positivacao/format';
import type { PositivacaoResumo, ClienteAPositivar } from '@/lib/positivacao/types';

export interface PositivacaoKpis {
  mes: string;
  totalEligible: number;
  positivados: number;
  pctPositivacao: number;
  ticketMedio: number;
  pctCobertura: number;
  recenciaCritica: number;
  novosPositivados: number;
  aPositivar: ClienteAPositivar[];
}

/**
 * KPIs de positivação do mês corrente (MTD) pra carteira PRÓPRIA do vendedor logado.
 * A verdade vem da RPC SECURITY DEFINER get_minha_positivacao() (usa auth.uid());
 * o JS só formata e ordena (helpers puros).
 */
export function useMyPositivacao() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-positivacao', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<PositivacaoKpis | null> => {
      if (!user) return null;
      // RPC ainda não está nos tipos gerados — cast no boundary (preserva `this` do client).
      const { data, error } = await (supabase as unknown as {
        rpc(fn: string): Promise<{ data: unknown; error: { message: string } | null }>;
      }).rpc('get_minha_positivacao');
      if (error) throw new Error(error.message);
      if (!data) return null;
      const r = data as PositivacaoResumo;
      return {
        mes: r.mes,
        totalEligible: r.total_eligible,
        positivados: r.positivados,
        pctPositivacao: pctPositivacao(r.positivados, r.total_eligible),
        ticketMedio: ticketMedio(r.receita_mtd, r.compradores_mtd),
        pctCobertura: pctCobertura(r.contatados_mtd, r.total_eligible),
        recenciaCritica: r.recencia_critica,
        novosPositivados: r.novos_clientes_positivados,
        aPositivar: rankAPositivar(r.a_positivar ?? []),
      };
    },
  });
}
