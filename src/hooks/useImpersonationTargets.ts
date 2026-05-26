import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { ImpersonationTarget } from '@/lib/impersonation/types';

export function useImpersonationTargets() {
  const { isMaster } = useAuth();
  return useQuery({
    queryKey: ['impersonation-targets'],
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
      return rows.map((r) => ({ id: r.user_id, nome: r.nome, grupo: grupo(r.commercial_role) }));
    },
  });
}
