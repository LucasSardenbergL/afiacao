import { Navigate, useLocation } from 'react-router-dom';
import { Loader2, Clock, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { user, loading, signOut, isApproved, refetchRole } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" state={{ from: location }} replace />;
  }

  if (!isApproved) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center">
              <Clock className="w-8 h-8 text-amber-600" />
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
              <Button variant="outline" onClick={() => signOut()} className="w-full">
                Sair
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
};