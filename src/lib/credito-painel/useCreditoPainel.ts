import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { lerPainelCredito, type PainelCredito } from './parse';

/** Erro da RPC com a SQLSTATE preservada (42501 = fora de gestor/master — o gate é do banco). */
export class ErroPainelCredito extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = 'ErroPainelCredito';
  }
}

export const PERIODOS_PAINEL = [30, 90, 180, 365] as const;
export type PeriodoPainel = (typeof PERIODOS_PAINEL)[number];

/**
 * Painel de crédito — 1 chamada, tudo agregado em SQL (`credito_painel_resumo`, SECURITY DEFINER).
 * Não há `.from()` nas tabelas credito_*: o PostgREST capa em 1.000 linhas e a soma tem de ser do banco.
 */
export function useCreditoPainel(dias: PeriodoPainel) {
  return useQuery<PainelCredito, ErroPainelCredito>({
    queryKey: ['credito-painel', dias],
    staleTime: 60_000,
    // 42501 não melhora com retry
    retry: (n, err) => err.code !== '42501' && n < 2,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('credito_painel_resumo', { p_dias: dias });
      if (error) throw new ErroPainelCredito(error.message, error.code ?? null);
      try {
        return lerPainelCredito(data);
      } catch (e) {
        throw new ErroPainelCredito(e instanceof Error ? e.message : String(e), null);
      }
    },
  });
}
