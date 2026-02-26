import { Navigate, useLocation } from 'react-router-dom';
import { Loader2, Clock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export const ProtectedRoute = ({ children }: ProtectedRouteProps) => {
  const { user, loading, signOut } = useAuth();
  const location = useLocation();
  const [approvalStatus, setApprovalStatus] = useState<boolean | null>(null);
  const [checkingApproval, setCheckingApproval] = useState(true);

  useEffect(() => {
    const checkApproval = async () => {
      if (!user) {
        setCheckingApproval(false);
        return;
      }

      try {
        // Check if user is staff (admin or employee) - they skip approval
        const { data: roleData } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', user.id)
          .maybeSingle();

        if (roleData?.role === 'admin' || roleData?.role === 'employee') {
          // Auto-approve employee profile if not yet approved
          await supabase
            .from('profiles')
            .update({ is_approved: true })
            .eq('user_id', user.id)
            .eq('is_approved', false);

          setApprovalStatus(true);
          setCheckingApproval(false);
          return;
        }

        const { data, error } = await supabase
          .from('profiles')
          .select('is_approved')
          .eq('user_id', user.id)
          .maybeSingle();

        if (error) {
          console.error('Error checking approval:', error);
          setApprovalStatus(true);
        } else {
          setApprovalStatus(data?.is_approved ?? false);
        }
      } catch {
        setApprovalStatus(true);
      } finally {
        setCheckingApproval(false);
      }
    };

    checkApproval();
  }, [user]);

  if (loading || checkingApproval) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/auth" state={{ from: location }} replace />;
  }

  if (approvalStatus === false) {
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
            <Button variant="outline" onClick={() => signOut()} className="w-full">
              Sair
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
};
