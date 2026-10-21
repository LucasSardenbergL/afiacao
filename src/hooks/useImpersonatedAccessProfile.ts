import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Database, Json } from '@/integrations/supabase/types';
import { useImpersonation } from '@/contexts/ImpersonationContext';

export interface TargetAccessProfile {
  appRole: 'employee' | 'customer' | 'master' | null;
  commercialRole: string | null;
  department: string | null;
  isSalesOnly: boolean;
}

const APP_ROLES: readonly Database['public']['Enums']['app_role'][] = ['master', 'employee', 'customer'];

function textoOuNulo(v: Json | undefined, chave: string): string | null {
  if (v === null || typeof v === 'string') return v;
  throw new Error(`get_user_access_profile_for: "${chave}" fora da forma (texto ou null)`);
}

/**
 * O jsonb da RPC, lido por forma. A função monta as 4 chaves com `jsonb_build_object` (NULL vem
 * explícito, nunca ausente); qualquer desvio LANÇA — a query vira erro e a lente não inventa
 * papel para o alvo (antes, `app_role` desconhecido passava direto por um `as`).
 */
function perfilDoJson(data: Json): TargetAccessProfile {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('get_user_access_profile_for: retorno não é objeto');
  }
  const appRole = textoOuNulo(data.app_role, 'app_role');
  const papel = appRole === null ? null : APP_ROLES.find((r) => r === appRole);
  if (papel === undefined) throw new Error(`get_user_access_profile_for: app_role desconhecido (${appRole})`);
  if (typeof data.is_sales_only !== 'boolean') {
    throw new Error('get_user_access_profile_for: "is_sales_only" fora da forma (booleano)');
  }
  return {
    appRole: papel,
    commercialRole: textoOuNulo(data.commercial_role, 'commercial_role'),
    department: textoOuNulo(data.department, 'department'),
    isSalesOnly: data.is_sales_only,
  };
}

export function useImpersonatedAccessProfile() {
  const { isImpersonating, target } = useImpersonation();
  return useQuery({
    queryKey: ['impersonated-access-profile', target?.id],
    enabled: isImpersonating && !!target,
    staleTime: 300_000,
    queryFn: async (): Promise<TargetAccessProfile | null> => {
      if (!target) return null;
      const { data, error } = await supabase.rpc('get_user_access_profile_for', { p_target: target.id });
      if (error) throw new Error(error.message);
      return perfilDoJson(data);
    },
  });
}
