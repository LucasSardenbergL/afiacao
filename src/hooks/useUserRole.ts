import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';

export type AppRole = 'employee' | 'customer' | 'master';

interface UseUserRoleReturn {
  role: AppRole | null;
  isAdmin: boolean;
  isEmployee: boolean;
  isCustomer: boolean;
  isMaster: boolean;
  isStaff: boolean; // admin OR employee OR master
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
        logger.critical('Failed to fetch user role (fail-closed: role=null)', {
          stage: 'fetch_role',
          userId: user.id,
          error,
        });
        setRole(null);
      } else {
        setRole((data?.role as AppRole) || 'customer');
      }
    } catch (error) {
      logger.critical('Unexpected error fetching user role (fail-closed: role=null)', {
        stage: 'fetch_role',
        userId: user.id,
        error,
      });
      setRole(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRole();
  }, [user?.id]);

  return {
    role,
    isAdmin: role === 'master',
    isEmployee: role === 'employee',
    isCustomer: role === 'customer',
    isMaster: role === 'master',
    isStaff: role === 'master' || role === 'employee',
    loading,
    refetch: fetchRole,
  };
}
