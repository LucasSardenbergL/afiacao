import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import type { Department } from '@/integrations/supabase/types-departments';

export interface UseUserDepartmentReturn {
  department: Department | null;
  isLoading: boolean;
}

/**
 * Departamento primário do usuário corrente. Lê `user_departments` filtrando
 * `primary_dept = true`. Reutilizado por `usePersona` como 4º sinal.
 */
export function useUserDepartment(): UseUserDepartmentReturn {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['user-department', user?.id],
    queryFn: async (): Promise<Department | null> => {
      if (!user?.id) return null;
      const { data } = await supabase
        .from('user_departments')
        .select('department')
        .eq('user_id', user.id)
        .eq('primary_dept', true)
        .maybeSingle();
      const row = data as { department?: Department } | null;
      return row?.department ?? null;
    },
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
  });

  return { department: data ?? null, isLoading: !!user?.id && isLoading };
}
