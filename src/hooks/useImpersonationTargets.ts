import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { ImpersonationTarget } from '@/lib/impersonation/types';

export function useImpersonationTargets() {
  const { isMaster, user } = useAuth();
  return useQuery({
    queryKey: ['impersonation-targets', user?.id],
    enabled: isMaster,
    staleTime: 300_000,
    queryFn: async (): Promise<ImpersonationTarget[]> => {
      const { data, error } = await (supabase as unknown as {
        rpc(fn: string): Promise<{ data: unknown; error: { message: string } | null }>;
      }).rpc('list_impersonation_targets');
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ user_id: string; nome: string; commercial_role: string | null }>;
      const grupo = (cr: string | null): ImpersonationTarget['grupo'] =>
        cr === 'hunter' ? 'hunter' : cr === 'closer' ? 'closer' : cr ? 'farmer' : null;
      // Exclui o PRÓPRIO master da lista — a RPC `list_impersonation_targets` devolve todos
      // os donos de carteira, e o master frequentemente também tem carteira própria; "ver
      // como você mesmo" não faz sentido (= só sair da lente). Saída é via "Sair" no banner.
      return rows
        .filter((r) => r.user_id !== user?.id)
        .map((r) => ({ id: r.user_id, nome: r.nome, grupo: grupo(r.commercial_role) }));
    },
  });
}
