import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

/**
 * Estado completo do sales-only: o flag + se as queries ainda estão carregando.
 * O `loading` é essencial pro controle de acesso fail-closed (não liberar rota
 * privilegiada na janela em que o sales-only ainda não resolveu). Ver useAccess.
 */
export function useSalesOnlyState(): { isSalesOnly: boolean; loading: boolean } {
  const { user } = useAuth();

  const cpfsQuery = useQuery({
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

  const docQuery = useQuery({
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

  // Carregando enquanto qualquer query relevante não resolveu (docQuery só conta
  // se há user — quando disabled, isLoading é false).
  const loading = cpfsQuery.isLoading || (!!user?.id && docQuery.isLoading);
  const salesOnlyCpfs = cpfsQuery.data;
  const userDoc = docQuery.data;
  const isSalesOnly = !salesOnlyCpfs || !userDoc ? false : salesOnlyCpfs.includes(userDoc);
  return { isSalesOnly, loading };
}

/**
 * Retorna true se o CPF do usuário está na lista `sales_only_cpfs` da company_config.
 * Wrapper booleano (compat) sobre useSalesOnlyState — reusado por AppShell/usePersona.
 */
export function useSalesOnlyRestriction(): boolean {
  return useSalesOnlyState().isSalesOnly;
}
