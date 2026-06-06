import { Navigate, Outlet } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useDisplayAccess } from '@/hooks/useDisplayAccess';

/**
 * Gate de rota: só staff passa. Na lente, usa o acesso de EXIBIÇÃO do alvo
 * (displayIsStaff) — assim o master, ao ver como uma vendedora, é barrado das
 * rotas que ela não acessa, reproduzindo a navegação dela. Fora da lente,
 * displayIsStaff === isStaff real. Fail-closed.
 */
export const RequireStaff = () => {
  const { loading } = useAuth();
  const { displayIsStaff, displayLoading } = useDisplayAccess();

  if (loading || displayLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!displayIsStaff) return <Navigate to="/" replace />;
  return <Outlet />;
};
