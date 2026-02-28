import React from 'react';
import { useUserRole } from '@/hooks/useUserRole';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FileText, Shield, History, AlertTriangle } from 'lucide-react';

export default function GovernanceAudit() {
  const { isAdmin } = useUserRole();
  const { isSuperAdmin, canViewStrategic } = useCommercialRole();

  const { data: permissionLog, isLoading: logLoading } = useQuery({
    queryKey: ['gov-audit-perms'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('permission_change_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin || isSuperAdmin,
  });

  const { data: algoLog, isLoading: algoLoading } = useQuery({
    queryKey: ['gov-audit-algo'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('farmer_audit_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return data || [];
    },
    enabled: isAdmin || isSuperAdmin,
  });

  const { data: marginLog } = useQuery({
    queryKey: ['gov-audit-margin'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('margin_audit_log')
        .select('*')
        .order('calculated_at', { ascending: false })
        .limit(50);
      if (error) { console.error(error); return []; }
      return data || [];
    },
    enabled: canViewStrategic || isAdmin,
  });

  if (!isAdmin && !isSuperAdmin) {
    return <div className="flex items-center justify-center h-64"><p className="text-muted-foreground">Acesso restrito</p></div>;
  }

  const isLoading = logLoading || algoLoading;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <FileText className="w-5 h-5" />
          Governança — Auditoria
        </h1>
        <p className="text-sm text-muted-foreground">
          Log completo de alterações de permissões, parâmetros e auditorias de margem
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : (
        <Tabs defaultValue="permissions">
          <TabsList className="h-8">
            <TabsTrigger value="permissions" className="text-xs px-3 h-7">
              <Shield className="w-3 h-3 mr-1" /> Permissões
            </TabsTrigger>
            <TabsTrigger value="algorithm" className="text-xs px-3 h-7">
              <History className="w-3 h-3 mr-1" /> Algoritmos
            </TabsTrigger>
            {(canViewStrategic || isAdmin) && (
              <TabsTrigger value="margin" className="text-xs px-3 h-7">
                <AlertTriangle className="w-3 h-3 mr-1" /> Margem (Alg. A)
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="permissions" className="mt-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Log de Alterações de Permissão</CardTitle>
                <CardDescription className="text-xs">{permissionLog?.length || 0} registros</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 font-medium text-muted-foreground">Usuário Alvo</th>
                        <th className="text-center py-2 font-medium text-muted-foreground">Tipo</th>
                        <th className="text-center py-2 font-medium text-muted-foreground">Anterior</th>
                        <th className="text-center py-2 font-medium text-muted-foreground">Novo</th>
                        <th className="text-center py-2 font-medium text-muted-foreground">Por</th>
                        <th className="text-right py-2 font-medium text-muted-foreground">Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {permissionLog?.map(log => (
                        <tr key={log.id} className="border-b border-border/50 hover:bg-muted/50">
                          <td className="py-2 font-mono">{log.target_user_id.slice(0, 8)}...</td>
                          <td className="text-center py-2"><Badge variant="outline" className="text-2xs">{log.change_type}</Badge></td>
                          <td className="text-center py-2 text-muted-foreground">{log.previous_value || '—'}</td>
                          <td className="text-center py-2">{log.new_value || '—'}</td>
                          <td className="text-center py-2 font-mono">{log.changed_by.slice(0, 8)}...</td>
                          <td className="text-right py-2 text-muted-foreground">
                            {new Date(log.created_at).toLocaleDateString('pt-BR')} {new Date(log.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                          </td>
                        </tr>
                      ))}
                      {(!permissionLog || permissionLog.length === 0) && (
                        <tr><td colSpan={6} className="text-center py-6 text-muted-foreground">Sem registros</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="algorithm" className="mt-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">Log de Alterações de Algoritmo</CardTitle>
                <CardDescription className="text-xs">{algoLog?.length || 0} registros</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 font-medium text-muted-foreground">Ação</th>
                        <th className="text-center py-2 font-medium text-muted-foreground">Entidade</th>
                        <th className="text-center py-2 font-medium text-muted-foreground">Versão</th>
                        <th className="text-center py-2 font-medium text-muted-foreground">Por</th>
                        <th className="text-left py-2 font-medium text-muted-foreground">Notas</th>
                        <th className="text-right py-2 font-medium text-muted-foreground">Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {algoLog?.map(log => (
                        <tr key={log.id} className="border-b border-border/50 hover:bg-muted/50">
                          <td className="py-2"><Badge variant="secondary" className="text-2xs">{log.action}</Badge></td>
                          <td className="text-center py-2">{log.entity_type}</td>
                          <td className="text-center py-2 font-mono">{log.algorithm_version}</td>
                          <td className="text-center py-2 font-mono">{log.performed_by.slice(0, 8)}...</td>
                          <td className="py-2 text-muted-foreground truncate max-w-[200px]">{log.notes || '—'}</td>
                          <td className="text-right py-2 text-muted-foreground">
                            {new Date(log.created_at!).toLocaleDateString('pt-BR')}
                          </td>
                        </tr>
                      ))}
                      {(!algoLog || algoLog.length === 0) && (
                        <tr><td colSpan={6} className="text-center py-6 text-muted-foreground">Sem registros</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {(canViewStrategic || isAdmin) && (
            <TabsContent value="margin" className="mt-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">Auditoria de Margem — Algoritmo A</CardTitle>
                  <CardDescription className="text-xs">{marginLog?.length || 0} registros</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 font-medium text-muted-foreground">Cliente</th>
                          <th className="text-center py-2 font-medium text-muted-foreground">M. Real</th>
                          <th className="text-center py-2 font-medium text-muted-foreground">M. Potencial</th>
                          <th className="text-center py-2 font-medium text-muted-foreground">Gap</th>
                          <th className="text-center py-2 font-medium text-muted-foreground">Gap %</th>
                          <th className="text-right py-2 font-medium text-muted-foreground">Calculado em</th>
                        </tr>
                      </thead>
                      <tbody>
                        {marginLog?.map(row => (
                          <tr key={row.id} className="border-b border-border/50 hover:bg-muted/50">
                            <td className="py-2 font-mono">{row.customer_user_id.slice(0, 8)}...</td>
                            <td className="text-center py-2">R$ {Number(row.margin_real).toLocaleString('pt-BR')}</td>
                            <td className="text-center py-2">R$ {Number(row.margin_potential).toLocaleString('pt-BR')}</td>
                            <td className="text-center py-2 text-destructive">R$ {Number(row.margin_gap).toLocaleString('pt-BR')}</td>
                            <td className="text-center py-2">{Number(row.gap_pct).toFixed(1)}%</td>
                            <td className="text-right py-2 text-muted-foreground">{new Date(row.calculated_at).toLocaleDateString('pt-BR')}</td>
                          </tr>
                        ))}
                        {(!marginLog || marginLog.length === 0) && (
                          <tr><td colSpan={6} className="text-center py-6 text-muted-foreground">Sem registros de auditoria</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}
