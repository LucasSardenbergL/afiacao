import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Lock, Eye, EyeOff, ShieldCheck } from 'lucide-react';

const PERMISSION_KEYS = [
  { key: 'view_margin_potential', label: 'Ver Margem Potencial', description: 'Acesso ao Algoritmo A e gap de margem' },
  { key: 'view_strategic_kpis', label: 'Ver KPIs Estratégicos', description: 'LTV, CAC, Market Share, Concentração' },
  { key: 'view_team_comparison', label: 'Ver Comparativo de Equipe', description: 'Ranking e métricas entre vendedores' },
  { key: 'edit_math_params', label: 'Editar Parâmetros Matemáticos', description: 'Ajustar pesos de Health/Priority Score' },
  { key: 'view_audit_log', label: 'Ver Log de Auditoria', description: 'Acesso ao log completo de alterações' },
  { key: 'simulate_user_view', label: 'Simular Visualização', description: 'Visualizar app como outro usuário' },
  { key: 'manage_roles', label: 'Gerenciar Perfis', description: 'Atribuir e alterar roles comerciais' },
];

export default function GovernancePermissions() {
  const { user } = useAuth();
  const { isAdmin } = useUserRole();
  const { isSuperAdmin } = useCommercialRole();
  const queryClient = useQueryClient();

  const { data: employees } = useQuery({
    queryKey: ['gov-perm-employees'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, email')
        .eq('is_employee', true);
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin || isSuperAdmin,
  });

  const { data: overrides, isLoading } = useQuery({
    queryKey: ['gov-perm-overrides'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('permission_overrides')
        .select('*');
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin || isSuperAdmin,
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ userId, permKey, granted }: { userId: string; permKey: string; granted: boolean }) => {
      // Check if override exists
      const existing = overrides?.find(o => o.user_id === userId && o.permission_key === permKey);
      if (existing) {
        const { error } = await supabase
          .from('permission_overrides')
          .update({ granted })
          .eq('id', existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('permission_overrides')
          .insert({ user_id: userId, permission_key: permKey, granted, granted_by: user?.id });
        if (error) throw error;
      }
      // Log change
      await supabase.from('permission_change_log').insert({
        target_user_id: userId,
        changed_by: user?.id || '',
        change_type: 'permission_override',
        new_value: `${permKey}=${granted}`,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gov-perm-overrides'] });
      toast.success('Permissão atualizada');
    },
    onError: (e: any) => toast.error('Erro: ' + e.message),
  });

  const getOverrideValue = (userId: string, permKey: string): boolean | null => {
    const o = overrides?.find(ov => ov.user_id === userId && ov.permission_key === permKey);
    return o ? o.granted : null;
  };

  if (!isAdmin && !isSuperAdmin) {
    return <div className="flex items-center justify-center h-64"><p className="text-muted-foreground">Acesso restrito</p></div>;
  }

  if (isLoading) {
    return <div className="space-y-4"><Skeleton className="h-8 w-64" />{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Lock className="w-5 h-5" />
          Governança — Permissões
        </h1>
        <p className="text-sm text-muted-foreground">
          Configure overrides de permissão por funcionário. Permissões padrão seguem o perfil comercial.
        </p>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-amber-500" />
          <span className="text-xs text-amber-700">
            O CPF mestre (Super Admin) ignora todas as restrições automaticamente.
          </span>
        </div>
      </div>

      {employees?.map(emp => (
        <Card key={emp.user_id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">{emp.name}</CardTitle>
            <CardDescription className="text-xs">{emp.email || emp.user_id.slice(0, 8)}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {PERMISSION_KEYS.map(perm => {
                const val = getOverrideValue(emp.user_id, perm.key);
                return (
                  <div key={perm.key} className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-muted/50">
                    <div>
                      <p className="text-xs font-medium">{perm.label}</p>
                      <p className="text-2xs text-muted-foreground">{perm.description}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {val === null && <Badge variant="outline" className="text-2xs">Padrão</Badge>}
                      <Switch
                        checked={val ?? false}
                        onCheckedChange={(checked) => toggleMutation.mutate({ userId: emp.user_id, permKey: perm.key, granted: checked })}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ))}

      {(!employees || employees.length === 0) && (
        <p className="text-sm text-muted-foreground text-center py-8">Nenhum funcionário encontrado</p>
      )}
    </div>
  );
}
