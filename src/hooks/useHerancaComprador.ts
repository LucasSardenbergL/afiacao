import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { lerHerancaComprador, type Heranca } from '@/lib/venda-cliente/heranca';

/**
 * O que o cliente herdou/repassou pelo plano de rateio de uma sucessão declarada (`venda_heranca_comprador`). Leitura
 * pura (allowlist da lente). Erro NÃO vira "sem herança": `erro` fica true e a ficha avisa.
 */
export function useHerancaComprador(compradorId: string | null): {
  herancas: Heranca[] | null;
  loading: boolean;
  erro: boolean;
} {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['venda-heranca-comprador', compradorId],
    enabled: !!compradorId,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<Heranca[]> => {
      const { data: raw, error } = await supabase.rpc('venda_heranca_comprador', { p_comprador: compradorId! });
      if (error) throw error;
      return lerHerancaComprador(raw);
    },
  });
  return { herancas: isError ? null : data ?? null, loading: !!compradorId && isLoading, erro: isError };
}
