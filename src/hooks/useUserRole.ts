import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

export type AppRole = 'admin' | 'employee' | 'customer';

interface UseUserRoleReturn {
  role: AppRole | null;
  isAdmin: boolean;
  isEmployee: boolean;
  isCustomer: boolean;
  isStaff: boolean; // admin OR employee
  loading: boolean;
  refetch: () => Promise<void>;
}

export function useUserRole(): UseUserRoleReturn {
  const { user } = useAuth();
  const [role, setRole] = useState<AppRole | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchRole = async () => {
    if (!user) {
      setRole(null);
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) {
        console.error('Error fetching user role:', error);
        setRole('customer');
      } else {
        setRole((data?.role as AppRole) || 'customer');
      }
    } catch (error) {
      console.error('Error fetching user role:', error);
      setRole('customer');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRole();
  }, [user?.id]);

  return {
    role,
    isAdmin: role === 'admin',
    isEmployee: role === 'employee',
    isCustomer: role === 'customer',
    isStaff: role === 'admin' || role === 'employee',
    loading,
    refetch: fetchRole,
  };
}
