import { Navigate, Outlet } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useMyCommercialRole } from '@/hooks/useMyCommercialRole';

/**
 * Gate fino da Caça (Frente B): a fila de look-alike é do HUNTER; o founder a
 * acessa como MASTER. Aninha DENTRO de <RequireStaff> (que já barra não-staff) e
 * restringe ainda mais — sem isto, qualquer employee (farmer/closer/sales-only)
 * entraria por URL direta em `/caca` (Codex P1).
 *
 * Autorizado: master (app_role, via useAuth) OU commercial_role ∈
 * {hunter, master, super_admin}. Demais staff → redirect '/'.
 * Fail-closed: role indefinido/erro → não-autorizado.
 */
export const RequireCaca = () => {
  const { isMaster, loading: authLoading } = useAuth();
  const { data: role, isLoading: roleLoading } = useMyCommercialRole();

  if (authLoading || roleLoading) {
    return (
      <div className="min-h-[40vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const autorizado =
    isMaster || role === 'hunter' || role === 'master' || role === 'super_admin';
  if (!autorizado) return <Navigate to="/" replace />;
  return <Outlet />;
};
