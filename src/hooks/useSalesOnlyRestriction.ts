import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

/**
 * Retorna true se o CPF do usuário está na lista `sales_only_cpfs` da company_config.
 * Extraído de AppShell.tsx pra ser reusado por usePersona e outros lugares.
 */
export function useSalesOnlyRestriction(): boolean {
  const { user } = useAuth();

  const { data: salesOnlyCpfs } = useQuery({
    queryKey: ['config', 'sales_only_cpfs'],
    queryFn: async () => {
      const { data } = await supabase
        .from('company_config')
        .select('value')
        .eq('key', 'sales_only_cpfs')
        .maybeSingle();
      return data?.value ? (JSON.parse(data.value) as string[]) : [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: userDoc } = useQuery({
    queryKey: ['profile', 'document', user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('document')
        .eq('user_id', user!.id)
        .maybeSingle();
      return data?.document?.replace(/\D/g, '') || null;
    },
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
  });

  if (!salesOnlyCpfs || !userDoc) return false;
  return salesOnlyCpfs.includes(userDoc);
}
