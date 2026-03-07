import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { Lock, ShieldCheck, Info, Settings, Eye, Brain } from 'lucide-react';

/* ─── Permission Definitions grouped by domain ─── */
interface PermDef {
  key: string;
  label: string;
  description: string;
}

interface PermGroup {
  domain: string;
  icon: React.ElementType;
  description: string;
  permissions: PermDef[];
}

const PERMISSION_GROUPS: PermGroup[] = [
  {
    domain: 'Inteligência Comercial',
    icon: Brain,
    description: 'Controla acesso a dados analíticos e métricas avançadas do módulo de inteligência.',
    permissions: [
      { key: 'view_margin_potential', label: 'Ver Margem Potencial', description: 'Libera acesso ao Algoritmo A (gap de margem real vs. potencial por cliente).' },
      { key: 'view_strategic_kpis', label: 'Ver KPIs Estratégicos', description: 'Libera painéis de LTV, CAC, Market Share e Concentração de Receita.' },
      { key: 'view_team_comparison', label: 'Ver Comparativo de Equipe', description: 'Libera ranking e métricas comparativas entre vendedores.' },
    ],
  },
  {
    domain: 'Governança & Parâmetros',
    icon: Settings,
    description: 'Controla quem pode alterar os algoritmos de scoring e revisar decisões automatizadas.',
    permissions: [
      { key: 'edit_math_params', label: 'Editar Parâmetros Matemáticos', description: 'Permite criar propostas de ajuste nos pesos de Health Score e Priority Score.' },
      { key: 'view_audit_log', label: 'Ver Log de Auditoria', description: 'Libera acesso ao histórico completo de alterações em parâmetros e propostas.' },
    ],
  },
  {
    domain: 'Visualização & Administração',
    icon: Eye,
    description: 'Capabilities administrativas que afetam a experiência de outros usuários.',
    permissions: [
      { key: 'simulate_user_view', label: 'Simular Visualização', description: 'Permite visualizar o aplicativo como outro funcionário (simulação read-only).' },
      { key: 'manage_roles', label: 'Gerenciar Perfis Comerciais', description: 'Permite atribuir e alterar roles comerciais (operacional, gerencial, estratégico).' },
    ],
  },
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
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <Lock className="w-5 h-5" />
          Permissões Granulares
        </h1>
        <p className="text-sm text-muted-foreground">
          Overrides individuais de capabilities por funcionário. Estas permissões complementam — não substituem — o papel comercial (role) de cada usuário.
        </p>
      </div>

      {/* Contextual notices */}
      <div className="space-y-2">
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/30 p-3">
          <Info className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-xs text-muted-foreground space-y-1">
            <p>
              <span className="font-medium text-foreground">Como funciona:</span> Cada funcionário herda permissões do seu role comercial (operacional, gerencial, estratégico).
              Os overrides abaixo permitem conceder ou revogar capabilities <span className="font-medium">específicas</span> além do que o role já define.
            </p>
            <p>
              Quando uma capability está em <Badge variant="outline" className="text-2xs mx-0.5 py-0">Padrão</Badge>, ela segue o que o role comercial determina. Ao ativar ou desativar explicitamente, o override tem precedência.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <ShieldCheck className="w-4 h-4 text-amber-500 shrink-0" />
          <span className="text-xs text-amber-700 dark:text-amber-400">
            O Super Admin ignora todas as restrições automaticamente — não precisa de overrides.
          </span>
        </div>
      </div>

      {/* Employee cards */}
      {employees?.map(emp => (
        <Card key={emp.user_id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">{emp.name}</CardTitle>
            <CardDescription className="text-xs">{emp.email || emp.user_id.slice(0, 8)}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {PERMISSION_GROUPS.map((group, gi) => {
              const GroupIcon = group.icon;
              return (
                <div key={group.domain}>
                  {gi > 0 && <Separator className="mb-3" />}
                  <div className="mb-2">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <GroupIcon className="w-3.5 h-3.5 text-primary" />
                      <span className="text-xs font-semibold text-foreground">{group.domain}</span>
                    </div>
                    <p className="text-2xs text-muted-foreground">{group.description}</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {group.permissions.map(perm => {
                      const val = getOverrideValue(emp.user_id, perm.key);
                      return (
                        <div key={perm.key} className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-muted/50">
                          <div className="pr-2">
                            <p className="text-xs font-medium">{perm.label}</p>
                            <p className="text-2xs text-muted-foreground leading-relaxed">{perm.description}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {val === null && <Badge variant="outline" className="text-2xs">Padrão</Badge>}
                            {val === true && <Badge className="text-2xs bg-emerald-500/10 text-emerald-600 border-emerald-500/20">Concedido</Badge>}
                            {val === false && <Badge variant="secondary" className="text-2xs">Revogado</Badge>}
                            <Switch
                              checked={val ?? false}
                              onCheckedChange={(checked) => toggleMutation.mutate({ userId: emp.user_id, permKey: perm.key, granted: checked })}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}

      {(!employees || employees.length === 0) && (
        <p className="text-sm text-muted-foreground text-center py-8">Nenhum funcionário encontrado</p>
      )}
    </div>
  );
}
