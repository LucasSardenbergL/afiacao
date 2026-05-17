import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { Department } from '@/integrations/supabase/types-departments';

export interface StaffUserRow {
  user_id: string;
  name: string | null;
  email: string | null;
  department: Department | null;
  is_approved: boolean;
}

/**
 * Lista staff (não-customer) + dept primário current. Para tela admin.
 */
export function useStaffUsersWithDept() {
  return useQuery<StaffUserRow[]>({
    queryKey: ['admin', 'departments', 'staff-users'],
    queryFn: async () => {
      // 1. Pega profiles staff (não customer)
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('user_id, name, email, is_approved')
        .order('name', { ascending: true });
      if (error) throw error;

      const ids = (profiles ?? []).map((p) => (p as { user_id: string }).user_id);
      if (ids.length === 0) return [];

      // 2. Filtra customer roles fora
      const { data: roles } = await supabase
        .from('user_roles')
        .select('user_id, role')
        .in('user_id', ids);
      const roleMap = new Map<string, string>();
      (roles ?? []).forEach((r) => {
        const row = r as { user_id: string; role: string };
        roleMap.set(row.user_id, row.role);
      });

      // 3. Carrega depts primários
      const { data: depts } = await supabase
        .from('user_departments')
        .select('user_id, department')
        .eq('primary_dept', true)
        .in('user_id', ids);
      const deptMap = new Map<string, Department>();
      (depts ?? []).forEach((d) => {
        const row = d as { user_id: string; department: Department };
        deptMap.set(row.user_id, row.department);
      });

      return (profiles ?? [])
        .filter((p) => roleMap.get((p as { user_id: string }).user_id) !== 'customer')
        .map((p) => {
          const row = p as {
            user_id: string;
            name: string | null;
            email: string | null;
            is_approved: boolean;
          };
          return {
            user_id: row.user_id,
            name: row.name,
            email: row.email,
            is_approved: row.is_approved,
            department: deptMap.get(row.user_id) ?? null,
          };
        });
    },
    staleTime: 60 * 1000,
  });
}

/**
 * Atribui dept primário ao usuário (substitui se já tiver).
 * Transação client-side: UPDATE old primary=false → INSERT new primary=true.
 * Em caso de race, o constraint UNIQUE EXCLUDE garante consistência.
 */
export function useAssignDepartment() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ userId, department }: { userId: string; department: Department }) => {
      // 1. Desativa primário atual (se existir)
      await supabase
        .from('user_departments')
        .update({ primary_dept: false })
        .eq('user_id', userId)
        .eq('primary_dept', true);

      // 2. Insere novo como primário
      const { error } = await supabase
        .from('user_departments')
        .insert({
          user_id: userId,
          department,
          primary_dept: true,
          created_by: user?.id ?? null,
        });
      if (error) throw error;
      return { userId, department };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'departments'] });
      queryClient.invalidateQueries({ queryKey: ['user-department'] });
    },
  });
}

/**
 * Remove TODOS os depts do usuário (não só primário). Reset full.
 */
export function useRemoveAllDepartments() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ userId }: { userId: string }) => {
      const { error } = await supabase
        .from('user_departments')
        .delete()
        .eq('user_id', userId);
      if (error) throw error;
      return { userId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'departments'] });
      queryClient.invalidateQueries({ queryKey: ['user-department'] });
    },
  });
}
