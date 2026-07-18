import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { Loader2, Check, X, UserCheck, Clock, Link2, AlertTriangle } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';

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
  const { user, isStaff, loading: authLoading } = useAuth();
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !isStaff) {
      navigate('/', { replace: true });
    }
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (user && isStaff) {
      loadPendingUsers();
    }
  }, [user, isStaff]);

  const loadPendingUsers = async () => {
    try {
      const { data: employeeRoles } = await supabase
        .from('user_roles')
        .select('user_id')
        .in('role', ['master', 'employee']);

      const employeeIds = new Set((employeeRoles || []).map(r => r.user_id));

      const { data, error } = await supabase
        .from('profiles')
        .select('id, user_id, name, email, phone, document, customer_type, created_at, prospect_source')
        .eq('is_approved', false)
        // Clientes-fantasma importados do Omie (prospect_source='omie_import') nunca pediram conta:
        // exclui-los NO SERVIDOR (antes do cap de 1000 do PostgREST) é obrigatório — com 1.633 imports,
        // filtrar só no cliente truncaria as pendências REAIS fora da janela
        // (ver docs/superpowers/specs/2026-06-12-clientes-cadastro-backfill-design.md).
        .or('prospect_source.is.null,prospect_source.neq.omie_import')
        .order('created_at', { ascending: false });

      if (error) throw error;

      const pendingOnly = (data || []).filter(p => !employeeIds.has(p.user_id));
      setPendingUsers(pendingOnly);

      const unapprovedEmployees = (data || []).filter(p => employeeIds.has(p.user_id));
      for (const emp of unapprovedEmployees) {
        await supabase
          .from('profiles')
          .update({ is_approved: true })
          .eq('user_id', emp.user_id);
      }
    } catch (error) {
      console.error('Error loading pending users:', error);
    } finally {
      setLoading(false);
    }
  };

  const tryLinkOmie = async (profileUserId: string, document: string | null, _name: string): Promise<'linked' | 'no_data' | 'already_linked' | 'not_found' | 'error'> => {
    if (!document) return 'no_data';

    const normalizedDoc = document.replace(/\D/g, '');
    if (!normalizedDoc) return 'no_data';

    try {
      // [P0-B-bis Fatia 4] O gate e o writer abaixo são um PAR INDIVISÍVEL: o que a checagem consulta
      // tem de ser onde o vínculo é gravado, senão `already_linked` mente e a aprovação re-registra.
      // Ambos saíram do espelho `omie_clientes` para a proof account-correta. `buscar_por_documento`
      // consulta a conta colacor_sc (credencial default de `omie-cliente`), que no espelho aparecia sob
      // o rótulo fabricado 'colacor' — na proof a conta é nomeada pelo que ela É: 'colacor_sc'.
      const { data: existing, error: existingError } = await supabase
        .from('omie_customer_account_map')
        .select('id')
        .eq('user_id', profileUserId)
        .eq('account', 'colacor_sc')
        .limit(1);

      // Fail-closed: engolir o erro faria a checagem devolver "não vinculado" e o writer tentaria
      // registrar por cima de um vínculo existente.
      if (existingError) {
        console.error('Error checking existing omie link:', existingError);
        return 'error';
      }

      if (existing && existing.length > 0) return 'already_linked';

      // Search Omie by document
      const { data, error } = await supabase.functions.invoke('omie-cliente', {
        body: { action: 'buscar_por_documento', documento: normalizedDoc },
      });

      if (error) {
        console.error('Error searching Omie by document:', error);
        return 'error';
      }

      if (data?.found && data?.codigo_cliente) {
        // Client exists in Omie — admite o membro na carteira pelas DUAS pontas (ledger + proof) via
        // RPC. `omie_codigo_cliente_integracao` foi DESCARTADO (resíduo §9 do design): 41 das 6909
        // linhas do espelho o tinham, todas de março, e nenhum leitor o consome.
        // as never: a RPC ainda não está nos tipos gerados do Supabase (regenerados pós-deploy).
        const { error: rpcError } = await supabase.rpc('register_carteira_member' as never, {
          p_user_id: profileUserId,
          p_account: 'colacor_sc',
          p_omie_codigo_cliente: data.codigo_cliente,
          p_omie_codigo_vendedor: data.codigo_vendedor ?? null,
        } as never);

        if (rpcError) {
          // 23505 = UNIQUE(omie_codigo_cliente, account): o código já é de OUTRO user nesta conta.
          // Fail-closed deliberado da RPC — não roubamos o vínculo alheio (mandaria pedido ao cliente
          // errado). Não é 'already_linked' (o gate acima já provou que ESTE user não tem vínculo).
          if (rpcError.code === '23505') {
            console.error('Código Omie já vinculado a outro usuário nesta conta:', rpcError);
            return 'error';
          }
          console.error('Error registering carteira member:', rpcError);
          return 'error';
        }

        return 'linked';
      }

      return 'not_found';
    } catch (err) {
      console.error('Error in tryLinkOmie:', err);
      return 'error';
    }
  };

  const handleApprove = async (pendingUser: PendingUser) => {
    setProcessing(pendingUser.user_id);
    try {
      // Step 1: Approve user
      const { error } = await supabase
        .from('profiles')
        .update({ is_approved: true })
        .eq('user_id', pendingUser.user_id);

      if (error) throw error;

      // Step 2: Try Omie link (non-blocking)
      const omieResult = await tryLinkOmie(pendingUser.user_id, pendingUser.document, pendingUser.name);

      setPendingUsers(prev => prev.filter(u => u.user_id !== pendingUser.user_id));

      // Step 3: Show feedback
      switch (omieResult) {
        case 'linked':
          toast.success('Aprovado e vinculado ao Omie ✓', {
            description: `${pendingUser.name} foi aprovado e vinculado automaticamente.`,
          });
          break;
        case 'already_linked':
          toast.success('Usuário aprovado', {
            description: 'Vínculo com Omie já existia.',
          });
          break;
        case 'not_found':
          toast.success('Aprovado — sem vínculo Omie', {
            description: 'Cliente não encontrado no Omie. Vincule manualmente se necessário.',
          });
          break;
        case 'no_data':
          toast.success('Usuário aprovado', {
            description: 'Sem CPF/CNPJ para busca automática no Omie.',
          });
          break;
        case 'error':
          toast.error('Aprovado — erro no vínculo Omie', {
            description: 'O usuário foi aprovado, mas a vinculação Omie falhou. Tente vincular manualmente.',
          });
          break;
      }
    } catch (error) {
      console.error('Error approving user:', error);
      toast.error('Erro', {
        description: 'Não foi possível aprovar o usuário.',
      });
    } finally {
      setProcessing(null);
    }
  };

  const handleReject = async (profileUserId: string) => {
    setProcessing(profileUserId);
    try {
      const { error } = await supabase
        .from('profiles')
        .delete()
        .eq('user_id', profileUserId);

      if (error) throw error;

      setPendingUsers(prev => prev.filter(u => u.user_id !== profileUserId));
      toast.success('Cadastro rejeitado', {
        description: 'O usuário foi removido.',
      });
    } catch (error) {
      console.error('Error rejecting user:', error);
      toast.error('Erro', {
        description: 'Não foi possível rejeitar o usuário.',
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
      <div className="min-h-screen bg-background pb-24">
        <main className="pt-16 px-4 max-w-4xl mx-auto">
          <PageSkeleton variant="list" />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">

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
              <Clock className="w-5 h-5 text-status-warning" />
              <span className="font-medium">{pendingUsers.length} pendente(s)</span>
            </div>

            <div className="flex items-center gap-2 rounded-lg border border-muted bg-muted/30 p-2.5 mb-2">
              <Link2 className="w-4 h-4 text-muted-foreground shrink-0" />
              <p className="text-xs text-muted-foreground">
                Ao aprovar, o sistema tentará vincular automaticamente o cliente ao Omie via CPF/CNPJ.
              </p>
            </div>

            {pendingUsers.map((pendingUser) => (
              <Card key={pendingUser.id}>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 flex-1 min-w-0">
                      <p className="font-semibold truncate">{pendingUser.name}</p>
                      <p className="text-sm text-muted-foreground truncate">{pendingUser.email || '-'}</p>
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm text-muted-foreground">
                          CPF/CNPJ: {formatDocument(pendingUser.document)}
                        </p>
                        {!pendingUser.document && (
                          <AlertTriangle className="w-3.5 h-3.5 text-status-warning" />
                        )}
                      </div>
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
                        onClick={() => handleApprove(pendingUser)}
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

    </div>
  );
};

export default AdminApprovals;
