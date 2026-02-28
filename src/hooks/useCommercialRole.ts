import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';

export type CommercialRole = 'operacional' | 'gerencial' | 'estrategico' | 'super_admin';

interface UseCommercialRoleReturn {
  commercialRole: CommercialRole | null;
  isSuperAdmin: boolean;
  isEstrategico: boolean;
  isGerencial: boolean;
  isOperacional: boolean;
  /** estrategico or super_admin */
  canViewStrategic: boolean;
  /** gerencial, estrategico or super_admin */
  canViewManagerial: boolean;
  loading: boolean;
  refetch: () => Promise<void>;
}

export function useCommercialRole(): UseCommercialRoleReturn {
  const { user } = useAuth();
  const [commercialRole, setCommercialRole] = useState<CommercialRole | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchRole = async () => {
    if (!user) {
      setCommercialRole(null);
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('commercial_roles')
        .select('commercial_role')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) {
        console.error('Error fetching commercial role:', error);
        setCommercialRole(null);
      } else {
        setCommercialRole((data?.commercial_role as CommercialRole) || null);
      }
    } catch (error) {
      console.error('Error fetching commercial role:', error);
      setCommercialRole(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRole();
  }, [user?.id]);

  const isSuperAdmin = commercialRole === 'super_admin';
  const isEstrategico = commercialRole === 'estrategico';
  const isGerencial = commercialRole === 'gerencial';
  const isOperacional = commercialRole === 'operacional';

  return {
    commercialRole,
    isSuperAdmin,
    isEstrategico,
    isGerencial,
    isOperacional,
    canViewStrategic: isSuperAdmin || isEstrategico,
    canViewManagerial: isSuperAdmin || isEstrategico || isGerencial,
    loading,
    refetch: fetchRole,
  };
}
