import { Link, Outlet } from 'react-router-dom';
import { Loader2, Lock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Defesa em profundidade da superfície de staff. O ProtectedRoute só checa
 * auth+aprovação (não role), então sem este guard um customer logado alcança
 * rotas administrativas pela URL (deep-link/bookmark). Libera staff
 * (employee/master); bloqueia o resto com uma tela clara. O gate real continua
 * no banco (RLS) — isto é UX + redução de superfície, não a barreira primária.
 * Espelha o padrão de RequireFinanceiroAccess (sem a query de fin_permissoes).
 */
export const RequireStaff = () => {
  const { isStaff, loading } = useAuth();

  // Não decide antes do role resolver — senão pisca bloqueio / falso-negativo no refresh.
  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isStaff) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-status-warning-bg flex items-center justify-center">
              <Lock className="w-8 h-8 text-status-warning" />
            </div>
            <h2 className="text-xl font-bold">Área restrita à equipe</h2>
            <p className="text-muted-foreground">
              Esta área é exclusiva para a equipe Colacor. Se você precisa de
              acesso, fale com um administrador.
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link to="/">Voltar ao início</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <Outlet />;
};
