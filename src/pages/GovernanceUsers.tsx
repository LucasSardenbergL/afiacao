import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { useCommercialRole, CommercialRole } from '@/hooks/useCommercialRole';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Shield, Users, History, ShieldCheck } from 'lucide-react';

const ROLE_LABELS: Record<string, string> = {
  operacional: 'Operacional',
  gerencial: 'Gerencial',
  estrategico: 'Estratégico',
  super_admin: 'Super Admin',
};

const ROLE_COLORS: Record<string, string> = {
  operacional: 'bg-blue-500/10 text-blue-700 border-blue-500/30',
  gerencial: 'bg-purple-500/10 text-purple-700 border-purple-500/30',
  estrategico: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  super_admin: 'bg-red-500/10 text-red-700 border-red-500/30',
};

export default function GovernanceUsers() {
  const { user } = useAuth();
  const { isAdmin } = useUserRole();
  const { isSuperAdmin } = useCommercialRole();
  const queryClient = useQueryClient();

  // Fetch all employees with profiles and commercial roles
  const { data: employees, isLoading } = useQuery({
    queryKey: ['governance-employees'],
    queryFn: async () => {
      // Get all employee profiles
      const { data: profiles, error: pError } = await supabase
        .from('profiles')
        .select('user_id, name, email, document, is_employee')
        .eq('is_employee', true);
      if (pError) throw pError;

      // Get all commercial roles
      const { data: roles, error: rError } = await supabase
        .from('commercial_roles')
        .select('user_id, commercial_role');
      if (rError) throw rError;

      const roleMap = new Map(roles?.map(r => [r.user_id, r.commercial_role]) || []);

      return (profiles || []).map(p => ({
        ...p,
        commercial_role: roleMap.get(p.user_id) || null,
      }));
    },
    enabled: isAdmin || isSuperAdmin,
  });

  // Fetch permission change log
  const { data: changeLog } = useQuery({
    queryKey: ['governance-log'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('permission_change_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin || isSuperAdmin,
  });

  // Mutation to set commercial role
  const setRoleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: CommercialRole }) => {
      // Upsert commercial role
      const { error } = await supabase
        .from('commercial_roles')
        .upsert({
          user_id: userId,
          commercial_role: role,
          assigned_by: user?.id,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
      if (error) throw error;

      // Log change
      await supabase.from('permission_change_log').insert({
        target_user_id: userId,
        changed_by: user?.id || '',
        change_type: 'commercial_role_change',
        new_value: role,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['governance-employees'] });
      queryClient.invalidateQueries({ queryKey: ['governance-log'] });
      toast.success('Perfil comercial atualizado');
    },
    onError: (e: any) => toast.error('Erro: ' + e.message),
  });

  if (!isAdmin && !isSuperAdmin) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Acesso restrito</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Shield className="w-5 h-5" />
          Governança — Usuários e Perfis
        </h1>
        <p className="text-sm text-muted-foreground">
          Gerencie perfis comerciais e permissões dos funcionários
        </p>
      </div>

      {/* Employee List */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Users className="w-4 h-4" />
            Funcionários ({employees?.length || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 font-medium text-muted-foreground">Nome</th>
                  <th className="text-left py-2 font-medium text-muted-foreground">Email</th>
                  <th className="text-center py-2 font-medium text-muted-foreground">Perfil Comercial</th>
                  <th className="text-right py-2 font-medium text-muted-foreground">Ação</th>
                </tr>
              </thead>
              <tbody>
                {employees?.map(emp => (
                  <tr key={emp.user_id} className="border-b border-border/50 hover:bg-muted/50">
                    <td className="py-2 font-medium">{emp.name}</td>
                    <td className="py-2 text-muted-foreground">{emp.email || '—'}</td>
                    <td className="text-center py-2">
                      {emp.commercial_role ? (
                        <Badge variant="outline" className={`text-2xs ${ROLE_COLORS[emp.commercial_role] || ''}`}>
                          {ROLE_LABELS[emp.commercial_role] || emp.commercial_role}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">Não definido</span>
                      )}
                    </td>
                    <td className="text-right py-2">
                      <Select
                        value={emp.commercial_role || ''}
                        onValueChange={(v) => setRoleMutation.mutate({ userId: emp.user_id, role: v as CommercialRole })}
                      >
                        <SelectTrigger className="h-7 w-[140px] text-xs ml-auto">
                          <SelectValue placeholder="Atribuir perfil" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="operacional">Operacional</SelectItem>
                          <SelectItem value="gerencial">Gerencial</SelectItem>
                          <SelectItem value="estrategico">Estratégico</SelectItem>
                          {isSuperAdmin && <SelectItem value="super_admin">Super Admin</SelectItem>}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                ))}
                {employees?.length === 0 && (
                  <tr><td colSpan={4} className="text-center py-6 text-muted-foreground">Nenhum funcionário encontrado</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Change Log */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <History className="w-4 h-4" />
            Log de Alterações
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {changeLog?.map(log => (
              <div key={log.id} className="flex items-center justify-between text-xs border-b border-border/50 py-2">
                <div>
                  <span className="font-mono">{log.target_user_id.slice(0, 8)}...</span>
                  <span className="mx-2 text-muted-foreground">→</span>
                  <Badge variant="outline" className="text-2xs">{log.new_value}</Badge>
                </div>
                <span className="text-muted-foreground">
                  {new Date(log.created_at).toLocaleDateString('pt-BR')} {new Date(log.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
            {(!changeLog || changeLog.length === 0) && (
              <p className="text-sm text-muted-foreground text-center py-4">Nenhuma alteração registrada</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
