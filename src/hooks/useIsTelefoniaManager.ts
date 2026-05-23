// src/hooks/useIsTelefoniaManager.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export function useIsTelefoniaManager(): boolean {
  const { user, isMaster } = useAuth();
  const { data } = useQuery({
    queryKey: ['commercial_role', user?.id], enabled: !!user?.id,
    queryFn: async () => {
       
      const { data } = await supabase.from('commercial_roles')
        .select('commercial_role').eq('user_id', user!.id).maybeSingle();
      return data?.commercial_role as string | undefined;
    },
  });
  return isMaster || ['gerencial', 'estrategico', 'super_admin'].includes(data ?? '');
}
