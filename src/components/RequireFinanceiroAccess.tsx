import { Link, Outlet } from 'react-router-dom';
import { Loader2, Lock } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { getMinhaPermissao } from '@/services/financeiroV2Service';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Defesa em profundidade do módulo financeiro. O ProtectedRoute só checa
 * auth+aprovação (não role), então sem este guard um customer logado alcança
 * /financeiro/* pela URL. Espelha o backend (fin_user_can_access): libera staff
 * (employee/master) OU quem tem linha em fin_permissoes; bloqueia o resto.
 * O gate real continua no banco (RPCs SECURITY DEFINER) — isto é UX + redução de
 * superfície, não a barreira primária.
 */
export const RequireFinanceiroAccess = () => {
  const { isStaff, loading } = useAuth();

  // fin_permissoes só importa pra não-staff; staff sempre passa (não busca à toa).
  const { data: perm, isLoading: permLoading } = useQuery({
    queryKey: ['fin-permissao-self'],
    queryFn: getMinhaPermissao,
    enabled: !loading && !isStaff,
    staleTime: 5 * 60 * 1000,
  });

  if (loading || (!isStaff && permLoading)) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isStaff && !perm) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-status-warning-bg flex items-center justify-center">
              <Lock className="w-8 h-8 text-status-warning" />
            </div>
            <h2 className="text-xl font-bold">Sem acesso ao Financeiro</h2>
            <p className="text-muted-foreground">
              Esta área é restrita a usuários com perfil financeiro. Fale com um
              administrador se precisar de acesso.
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
