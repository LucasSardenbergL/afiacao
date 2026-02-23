import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Check, X, UserCheck, Clock } from 'lucide-react';

interface PendingUser {
  id: string;
  user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  document: string | null;
  customer_type: string | null;
  created_at: string;
}

const AdminApprovals = () => {
  const navigate = useNavigate();
  const { user, isAdmin, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !isAdmin) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isAdmin, navigate]);

  useEffect(() => {
    if (user && isAdmin) {
      loadPendingUsers();
    }
  }, [user, isAdmin]);

  const loadPendingUsers = async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, user_id, name, email, phone, document, customer_type, created_at')
        .eq('is_approved', false)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setPendingUsers(data || []);
    } catch (error) {
      console.error('Error loading pending users:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (profileUserId: string) => {
    setProcessing(profileUserId);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ is_approved: true })
        .eq('user_id', profileUserId);

      if (error) throw error;

      setPendingUsers(prev => prev.filter(u => u.user_id !== profileUserId));
      toast({
        title: 'Usuário aprovado',
        description: 'O acesso foi liberado com sucesso.',
      });
    } catch (error) {
      console.error('Error approving user:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível aprovar o usuário.',
        variant: 'destructive',
      });
    } finally {
      setProcessing(null);
    }
  };

  const handleReject = async (profileUserId: string) => {
    setProcessing(profileUserId);
    try {
      // Delete profile (user can't access)
      const { error } = await supabase
        .from('profiles')
        .delete()
        .eq('user_id', profileUserId);

      if (error) throw error;

      setPendingUsers(prev => prev.filter(u => u.user_id !== profileUserId));
      toast({
        title: 'Cadastro rejeitado',
        description: 'O usuário foi removido.',
      });
    } catch (error) {
      console.error('Error rejecting user:', error);
      toast({
        title: 'Erro',
        description: 'Não foi possível rejeitar o usuário.',
        variant: 'destructive',
      });
    } finally {
      setProcessing(null);
    }
  };

  const formatDocument = (doc: string | null) => {
    if (!doc) return '-';
    if (doc.length === 11) {
      return doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    }
    if (doc.length === 14) {
      return doc.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    }
    return doc;
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Aprovação de Cadastros" showBack />

      <main className="pt-16 px-4 max-w-4xl mx-auto">
        {pendingUsers.length === 0 ? (
          <div className="text-center py-12 space-y-3">
            <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
              <UserCheck className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-lg font-semibold">Nenhum cadastro pendente</h3>
            <p className="text-muted-foreground text-sm">
              Todos os cadastros foram processados.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-4">
              <Clock className="w-5 h-5 text-amber-600" />
              <span className="font-medium">{pendingUsers.length} pendente(s)</span>
            </div>
            {pendingUsers.map((pendingUser) => (
              <Card key={pendingUser.id}>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 flex-1 min-w-0">
                      <p className="font-semibold truncate">{pendingUser.name}</p>
                      <p className="text-sm text-muted-foreground truncate">{pendingUser.email || '-'}</p>
                      <p className="text-sm text-muted-foreground">
                        CPF/CNPJ: {formatDocument(pendingUser.document)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(pendingUser.created_at).toLocaleDateString('pt-BR')}
                      </p>
                      {pendingUser.customer_type && (
                        <Badge variant="outline" className="text-xs">
                          {pendingUser.customer_type === 'industrial' ? 'Industrial' : 'Doméstico'}
                        </Badge>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive border-destructive/30"
                        onClick={() => handleReject(pendingUser.user_id)}
                        disabled={processing === pendingUser.user_id}
                      >
                        {processing === pendingUser.user_id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <X className="w-4 h-4" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleApprove(pendingUser.user_id)}
                        disabled={processing === pendingUser.user_id}
                      >
                        {processing === pendingUser.user_id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <Check className="w-4 h-4 mr-1" />
                            Aprovar
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

export default AdminApprovals;
