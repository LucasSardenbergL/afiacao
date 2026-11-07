import { Navigate, useLocation } from 'react-router-dom';
import { Clock, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useSaidaComFilaPendente } from '@/components/shell/SaidaComFilaPendente';
import { rotaDeLogin } from '@/lib/destino-pos-login';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { user, loading, isApproved, refetchRole } = useAuth();
  const { pedirSaida, dialogoSaida } = useSaidaComFilaPendente();
  const location = useLocation();

  if (loading) {
    return <PageSkeleton variant="auto" />;
  }

  if (!user) {
    // O destino vai em `?next=` (sobrevive a recarregar a aba; o /auth honra) e em `state.from`. Sem isso, quem
    // abre o link do e-mail do Radar sem sessão loga e cai na home, não na ficha.
    const destino = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={rotaDeLogin(destino)} state={{ from: location }} replace />;
  }

  if (!isApproved) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-status-warning-bg flex items-center justify-center">
              <Clock className="w-8 h-8 text-status-warning" />
            </div>
            <h2 className="text-xl font-bold">Cadastro Pendente de Aprovação</h2>
            <p className="text-muted-foreground">
              Seu cadastro foi recebido e está aguardando liberação pelo administrador. 
              Você será notificado por e-mail quando for aprovado.
            </p>
            <div className="flex flex-col gap-2">
              <Button onClick={() => refetchRole()} className="w-full gap-2">
                <RefreshCw className="w-4 h-4" />
                Verificar novamente
              </Button>
              <Button variant="outline" onClick={pedirSaida} className="w-full">
                Sair
              </Button>
            </div>
          </CardContent>
        </Card>
        {dialogoSaida}
      </div>
    );
  }

  return <>{children}</>;
};