import { useState, useEffect, useMemo } from 'react';
import { useUserRole } from '@/hooks/useUserRole';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { supabase } from '@/integrations/supabase/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Settings, Factory, ShieldAlert } from 'lucide-react';

const CONFIG_KEY = 'default_production_assignee_id';

export default function GovernanceSettings() {
  const { isAdmin } = useUserRole();
  const { isSuperAdmin } = useCommercialRole();
  const queryClient = useQueryClient();
  const allowed = isAdmin || isSuperAdmin;

  // Eligible assignees: profiles with role admin/employee/master
  const { data: eligible, isLoading: loadingUsers } = useQuery({
    queryKey: ['governance-settings-eligible-assignees'],
    queryFn: async () => {
      const { data: roles, error: rErr } = await supabase
        .from('user_roles')
        .select('user_id, role')
        .in('role', ['admin', 'employee', 'master']);
      if (rErr) throw rErr;
      const ids = Array.from(new Set((roles || []).map(r => r.user_id)));
      if (ids.length === 0) return [];
      const { data: profiles, error: pErr } = await supabase
        .from('profiles')
        .select('user_id, name, email')
        .in('user_id', ids);
      if (pErr) throw pErr;
      const roleMap = new Map((roles || []).map(r => [r.user_id, r.role]));
      return (profiles || [])
        .map(p => ({ ...p, role: roleMap.get(p.user_id) as string }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    },
    enabled: allowed,
  });

  const { data: currentValue, isLoading: loadingValue } = useQuery({
    queryKey: ['governance-settings', CONFIG_KEY],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('company_config')
        .select('value')
        .eq('key', CONFIG_KEY)
        .maybeSingle();
      if (error) throw error;
      return data?.value || '';
    },
    enabled: allowed,
  });

  const [selected, setSelected] = useState<string>('');
  useEffect(() => { if (currentValue) setSelected(currentValue); }, [currentValue]);

  const currentLabel = useMemo(() => {
    const u = eligible?.find(e => e.user_id === currentValue);
    return u ? `${u.name || u.email} · ${u.role}` : currentValue || '—';
  }, [eligible, currentValue]);

  const saveMutation = useMutation({
    mutationFn: async (value: string) => {
      const { data: existing } = await supabase
        .from('company_config')
        .select('id')
        .eq('key', CONFIG_KEY)
        .maybeSingle();
      if (existing) {
        const { error } = await supabase
          .from('company_config')
          .update({ value, updated_at: new Date().toISOString() })
          .eq('key', CONFIG_KEY);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('company_config')
          .insert({ key: CONFIG_KEY, value });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success('Responsável padrão de produção atualizado');
      queryClient.invalidateQueries({ queryKey: ['governance-settings', CONFIG_KEY] });
    },
    onError: (e: any) => toast.error(e?.message || 'Falha ao salvar'),
  });

  if (!allowed) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="flex items-center gap-3 py-8">
            <ShieldAlert className="w-5 h-5 text-destructive" />
            <p className="text-sm">Acesso restrito a administradores.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const dirty = selected && selected !== currentValue;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Settings className="w-6 h-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Governança · Configurações</h1>
          <p className="text-sm text-muted-foreground">Parâmetros operacionais globais do sistema.</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Factory className="w-4 h-4" /> Responsável padrão · Ordens de Produção
          </CardTitle>
          <CardDescription>
            Usuário que recebe automaticamente as Ordens de Produção criadas a partir de pedidos de venda Colacor com itens do tipo <strong>produto acabado</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm">
            <span className="text-muted-foreground">Atual: </span>
            {loadingValue ? <Skeleton className="inline-block h-4 w-40 align-middle" /> : <strong>{currentLabel}</strong>}
          </div>

          {loadingUsers ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione um responsável" />
              </SelectTrigger>
              <SelectContent>
                {(eligible || []).map(u => (
                  <SelectItem key={u.user_id} value={u.user_id}>
                    {u.name || u.email} <span className="text-muted-foreground">· {u.role}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <div className="flex justify-end">
            <Button
              onClick={() => saveMutation.mutate(selected)}
              disabled={!dirty || saveMutation.isPending}
            >
              {saveMutation.isPending ? 'Salvando…' : 'Salvar'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}