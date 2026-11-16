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
import { documentoParaBuscarNoOmie } from '@/lib/omie/documento-cliente';
import { mensagemDeErro } from '@/lib/erro-mensagem';

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

  type ResultadoVinculo =
    | { tipo: 'linked' | 'no_data' | 'already_linked' | 'not_found' }
    | { tipo: 'pendente' | 'recusado' | 'error'; motivo: string };

  // b339bb5b (residual): o vínculo do cadastro aprovado é decidido NO SERVIDOR. A edge lê o CPF/CNPJ do
  // cadastro, acha o código único dele na Omie da Colacor SC, confere com ConsultarCliente e só então
  // admite (admitir_vinculo_conferido). O browser não manda código nenhum: antes ele recebia o código e
  // chamava a RPC de carteira com ele, e um código de OUTRO cliente fazia a dona dele cair para Hunter.
  // O gate `already_linked` e o writer vivem juntos na edge (par indivisível, Fatia 4).
  const tryLinkOmie = async (profileUserId: string, document: string | null): Promise<ResultadoVinculo> => {
    if (!document || !documentoParaBuscarNoOmie(document)) return { tipo: 'no_data' };

    try {
      const { data, error } = await supabase.functions.invoke('omie-cliente', {
        body: { action: 'vincular_aprovado', user_id: profileUserId },
      });
      // Em 409/422/503 o supabase-js devolve `data: null` e o corpo {status, error} fica AINDA POR LER na
      // Response de `error.context` (Codex): sem isto, pendente e recusado caíam todos em "erro genérico".
      let corpo: { status?: unknown; error?: unknown } | null = data ?? null;
      const ctx = (error as { context?: unknown } | null)?.context;
      if (!corpo && ctx && typeof (ctx as Response).clone === 'function') {
        try {
          corpo = await (ctx as Response).clone().json();
        } catch {
          corpo = null; // corpo não-JSON: segue como erro genérico
        }
      }
      const status = typeof corpo?.status === 'string' ? corpo.status : undefined;
      const motivo: string = (typeof corpo?.error === 'string' ? corpo.error : null)
        ?? mensagemDeErro(error) ?? 'Falha ao conferir o vínculo na Omie.';

      if (status === 'vinculado') return { tipo: 'linked' };
      if (status === 'ja_vinculado') return { tipo: 'already_linked' };
      if (status === 'nao_encontrado') return { tipo: 'not_found' };
      if (status === 'sem_documento') return { tipo: 'no_data' };
      // Ausente ≠ ok: sem resposta da Omie o vínculo fica pendente (não existe) e o motivo aparece.
      if (status === 'pendente') return { tipo: 'pendente', motivo };
      if (status === 'recusado') return { tipo: 'recusado', motivo };
      console.error('Error linking Omie:', error ?? data);
      return { tipo: 'error', motivo };
    } catch (err) {
      console.error('Error in tryLinkOmie:', err);
      return { tipo: 'error', motivo: 'Falha ao conferir o vínculo na Omie.' };
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
      const omieResult = await tryLinkOmie(pendingUser.user_id, pendingUser.document);

      setPendingUsers(prev => prev.filter(u => u.user_id !== pendingUser.user_id));

      // Step 3: Show feedback
      switch (omieResult.tipo) {
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
        case 'pendente':
          toast.warning('Aprovado — vínculo Omie pendente', {
            description: `${omieResult.motivo} O vínculo não foi criado; o sync liga quando a Omie responder.`,
          });
          break;
        case 'recusado':
          toast.error('Aprovado — vínculo Omie recusado', {
            description: omieResult.motivo,
          });
          break;
        case 'error':
          toast.error('Aprovado — erro no vínculo Omie', {
            description: `O usuário foi aprovado, mas a vinculação Omie falhou: ${omieResult.motivo}`,
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
