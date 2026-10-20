import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { hojeSP } from '@/lib/time/sp-day';

/**
 * Contatos já registrados HOJE pela vendedora (por comprador → último resultado do dia).
 * Leitura de tabela (RLS: a farmer lê as suas; o master lê todas) — por isso funciona na
 * lente "Ver como" filtrando pelo `effectiveUserId`.
 */
export function useContatosDoDia() {
  const { user } = useAuth();
  const { effectiveUserId } = useImpersonation();
  const dono = effectiveUserId ?? user?.id ?? null;
  const dia = hojeSP();
  return useQuery({
    queryKey: ['venda-contatos-do-dia', dono, dia],
    enabled: !!dono,
    staleTime: 30_000,
    queryFn: async (): Promise<Map<string, string>> => {
      const { data, error } = await supabase
        .from('venda_contato')
        .select('comprador_id, resultado')
        .eq('farmer_user_id', dono!)
        .eq('dia', dia)
        .limit(1000);
      if (error) throw error;
      return new Map((data ?? []).map((r) => [r.comprador_id, r.resultado]));
    },
  });
}
