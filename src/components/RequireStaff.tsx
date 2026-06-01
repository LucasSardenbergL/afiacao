import { Navigate, Outlet } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Gate de rota: só staff (isAdmin || isEmployee || isMaster) passa.
 * Não-staff (customer) é redirecionado pra '/' (cai no CustomerDashboard).
 * Fail-closed: se o role falhou ao carregar, isStaff=false → redirect (seguro).
 * O '/' fica FORA deste gate, então não há loop de redirect.
 */
export const RequireStaff = () => {
  const { isStaff, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!isStaff) return <Navigate to="/" replace />;
  return <Outlet />;
};
