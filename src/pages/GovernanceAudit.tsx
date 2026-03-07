import React, { useState, useMemo } from 'react';
import { useUserRole } from '@/hooks/useUserRole';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  FileText, Shield, History, AlertTriangle, User, Calendar,
  ArrowRight, ChevronDown, ChevronUp, Filter, Search,
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

/* ─── Helpers ─── */

const ACTION_LABELS: Record<string, { label: string; color: string }> = {
  proposal_created: { label: 'Proposta criada', color: 'bg-blue-500/10 text-blue-700 border-blue-500/20' },
  proposal_approved: { label: 'Proposta aprovada', color: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/20' },
  proposal_rejected: { label: 'Proposta rejeitada', color: 'bg-destructive/10 text-destructive border-destructive/20' },
  param_updated: { label: 'Parâmetro alterado', color: 'bg-amber-500/10 text-amber-700 border-amber-500/20' },
  permission_override: { label: 'Override de permissão', color: 'bg-purple-500/10 text-purple-700 border-purple-500/20' },
  role_changed: { label: 'Role alterado', color: 'bg-orange-500/10 text-orange-700 border-orange-500/20' },
};

function getActionMeta(action: string) {
  return ACTION_LABELS[action] || { label: action, color: 'bg-muted text-muted-foreground border-border' };
}

function formatDate(d: string | null) {
  if (!d) return '—';
  return format(new Date(d), "dd MMM yyyy, HH:mm", { locale: ptBR });
}

function formatDateShort(d: string | null) {
  if (!d) return '—';
  return format(new Date(d), "dd/MM/yy HH:mm");
}

const ENTITY_LABELS: Record<string, string> = {
  governance_proposal: 'Proposta de Governança',
  algorithm_config: 'Configuração do Algoritmo',
  permission: 'Permissão',
  commercial_role: 'Role Comercial',
};

/* ─── Diff viewer for before/after params ─── */
function ParamsDiff({ before, after }: { before: Record<string, any> | null; after: Record<string, any> | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!before && !after) return null;

  const allKeys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  const changedKeys = allKeys.filter(k => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));

  if (changedKeys.length === 0) return <span className="text-2xs text-muted-foreground italic">Sem diferenças</span>;

  const visible = expanded ? changedKeys : changedKeys.slice(0, 3);

  return (
    <div className="space-y-1">
      {visible.map(key => (
        <div key={key} className="flex items-center gap-1.5 text-2xs">
          <span className="font-mono text-muted-foreground">{key}:</span>
          <span className="text-destructive/80 line-through">{JSON.stringify(before?.[key] ?? '—')}</span>
          <ArrowRight className="w-2.5 h-2.5 text-muted-foreground" />
          <span className="text-emerald-600 font-medium">{JSON.stringify(after?.[key] ?? '—')}</span>
        </div>
      ))}
      {changedKeys.length > 3 && (
        <button onClick={() => setExpanded(!expanded)} className="text-2xs text-primary hover:underline flex items-center gap-0.5">
          {expanded ? <><ChevronUp className="w-3 h-3" /> Menos</> : <><ChevronDown className="w-3 h-3" /> +{changedKeys.length - 3} parâmetros</>}
        </button>
      )}
    </div>
  );
}

/* ─── Main Component ─── */
export default function GovernanceAudit() {
  const { isAdmin } = useUserRole();
  const { isSuperAdmin, canViewStrategic } = useCommercialRole();

  // Filters
  const [actionFilter, setActionFilter] = useState<string>('all');
  const [authorFilter, setAuthorFilter] = useState<string>('all');
  const [searchText, setSearchText] = useState('');

  // Load profiles for name resolution
  const { data: profilesMap } = useQuery({
    queryKey: ['gov-audit-profiles'],
    queryFn: async () => {
      const { data } = await supabase.from('profiles').select('user_id, name');
      const map = new Map<string, string>();
      (data || []).forEach(p => map.set(p.user_id, p.name));
      return map;
    },
    enabled: isAdmin || isSuperAdmin,
  });

  const resolveName = (uid: string | null) => {
    if (!uid) return '—';
    return profilesMap?.get(uid) || uid.slice(0, 8) + '…';
  };

  const { data: permissionLog, isLoading: logLoading } = useQuery({
    queryKey: ['gov-audit-perms'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('permission_change_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
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
        .limit(200);
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

  // Unique authors from algo logs for filter
  const authorOptions = useMemo(() => {
    const ids = new Set<string>();
    algoLog?.forEach(l => ids.add(l.performed_by));
    permissionLog?.forEach(l => ids.add(l.changed_by));
    return [...ids].map(id => ({ id, name: resolveName(id) }));
  }, [algoLog, permissionLog, profilesMap]);

  // Unique actions from algo logs for filter
  const actionOptions = useMemo(() => {
    const actions = new Set<string>();
    algoLog?.forEach(l => actions.add(l.action));
    return [...actions];
  }, [algoLog]);

  // Filtered algo logs
  const filteredAlgoLog = useMemo(() => {
    if (!algoLog) return [];
    return algoLog.filter(log => {
      if (actionFilter !== 'all' && log.action !== actionFilter) return false;
      if (authorFilter !== 'all' && log.performed_by !== authorFilter) return false;
      if (searchText) {
        const q = searchText.toLowerCase();
        const name = resolveName(log.performed_by).toLowerCase();
        const entity = (log.entity_type || '').toLowerCase();
        const notes = (log.notes || '').toLowerCase();
        if (!name.includes(q) && !entity.includes(q) && !notes.includes(q) && !log.action.includes(q)) return false;
      }
      return true;
    });
  }, [algoLog, actionFilter, authorFilter, searchText, profilesMap]);

  // Filtered permission logs
  const filteredPermLog = useMemo(() => {
    if (!permissionLog) return [];
    return permissionLog.filter(log => {
      if (authorFilter !== 'all' && log.changed_by !== authorFilter) return false;
      if (searchText) {
        const q = searchText.toLowerCase();
        const name = resolveName(log.changed_by).toLowerCase();
        const target = resolveName(log.target_user_id).toLowerCase();
        if (!name.includes(q) && !target.includes(q) && !(log.new_value || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [permissionLog, authorFilter, searchText, profilesMap]);

  if (!isAdmin && !isSuperAdmin) {
    return <div className="flex items-center justify-center h-64"><p className="text-muted-foreground">Acesso restrito</p></div>;
  }

  const isLoading = logLoading || algoLoading;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
          <FileText className="w-5 h-5" />
          Auditoria de Governança
        </h1>
        <p className="text-sm text-muted-foreground">
          Histórico de alterações em permissões, parâmetros e propostas — quem mudou o quê, quando e com qual impacto.
        </p>
      </div>

      {/* Filters bar */}
      <Card>
        <CardContent className="py-3 px-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Filter className="w-3.5 h-3.5" /> Filtros:
            </div>
            <div className="flex items-center gap-1.5">
              <Search className="w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome, ação, nota..."
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className="h-7 text-xs w-48"
              />
            </div>
            <Select value={authorFilter} onValueChange={setAuthorFilter}>
              <SelectTrigger className="h-7 text-xs w-40">
                <User className="w-3 h-3 mr-1" />
                <SelectValue placeholder="Autor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os autores</SelectItem>
                {authorOptions.map(a => (
                  <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger className="h-7 text-xs w-44">
                <Calendar className="w-3 h-3 mr-1" />
                <SelectValue placeholder="Tipo de ação" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as ações</SelectItem>
                {actionOptions.map(a => (
                  <SelectItem key={a} value={a}>{getActionMeta(a).label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : (
        <Tabs defaultValue="algorithm">
          <TabsList className="h-8">
            <TabsTrigger value="algorithm" className="text-xs px-3 h-7">
              <History className="w-3 h-3 mr-1" /> Algoritmos & Propostas
              <Badge variant="secondary" className="ml-1.5 text-2xs px-1.5">{filteredAlgoLog.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="permissions" className="text-xs px-3 h-7">
              <Shield className="w-3 h-3 mr-1" /> Permissões
              <Badge variant="secondary" className="ml-1.5 text-2xs px-1.5">{filteredPermLog.length}</Badge>
            </TabsTrigger>
            {(canViewStrategic || isAdmin) && (
              <TabsTrigger value="margin" className="text-xs px-3 h-7">
                <AlertTriangle className="w-3 h-3 mr-1" /> Margem (Alg. A)
              </TabsTrigger>
            )}
          </TabsList>

          {/* ─── Algorithm & Proposals tab ─── */}
          <TabsContent value="algorithm" className="mt-4 space-y-2">
            {filteredAlgoLog.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">Nenhum registro encontrado com os filtros atuais</p>
            )}
            {filteredAlgoLog.map(log => {
              const meta = getActionMeta(log.action);
              return (
                <Card key={log.id} className="overflow-hidden">
                  <div className="flex items-start gap-3 p-3">
                    {/* Left: color bar */}
                    <div className={`w-1 self-stretch rounded-full shrink-0 ${
                      log.action.includes('approved') ? 'bg-emerald-500' :
                      log.action.includes('rejected') ? 'bg-destructive' :
                      log.action.includes('created') ? 'bg-blue-500' : 'bg-amber-500'
                    }`} />

                    <div className="flex-1 min-w-0 space-y-1.5">
                      {/* Header row */}
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2">
                          <Badge className={`text-2xs ${meta.color}`}>{meta.label}</Badge>
                          <span className="text-2xs text-muted-foreground">
                            {ENTITY_LABELS[log.entity_type] || log.entity_type}
                          </span>
                          {log.algorithm_version && (
                            <span className="text-2xs font-mono text-muted-foreground">{log.algorithm_version}</span>
                          )}
                        </div>
                        <span className="text-2xs text-muted-foreground whitespace-nowrap">
                          {formatDate(log.created_at)}
                        </span>
                      </div>

                      {/* Author */}
                      <div className="flex items-center gap-1 text-xs">
                        <User className="w-3 h-3 text-muted-foreground" />
                        <span className="font-medium">{resolveName(log.performed_by)}</span>
                      </div>

                      {/* Notes */}
                      {log.notes && (
                        <p className="text-xs text-muted-foreground bg-muted/50 rounded px-2 py-1 italic">
                          "{log.notes}"
                        </p>
                      )}

                      {/* Before/After diff */}
                      {(log.previous_params || log.new_params) && (
                        <div className="pt-1">
                          <p className="text-2xs font-medium text-muted-foreground mb-1">Alterações nos parâmetros:</p>
                          <ParamsDiff
                            before={log.previous_params as Record<string, any> | null}
                            after={log.new_params as Record<string, any> | null}
                          />
                        </div>
                      )}

                      {/* Projection */}
                      {log.projection && typeof log.projection === 'object' && (
                        <div className="flex gap-3 pt-1">
                          {Object.entries(log.projection as Record<string, any>).filter(([, v]) => v != null).map(([k, v]) => (
                            <span key={k} className="text-2xs">
                              <span className="text-muted-foreground">{k.replace(/_/g, ' ')}:</span>{' '}
                              <span className="font-medium">{typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : String(v)}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </TabsContent>

          {/* ─── Permissions tab ─── */}
          <TabsContent value="permissions" className="mt-4 space-y-2">
            {filteredPermLog.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">Nenhum registro encontrado com os filtros atuais</p>
            )}
            {filteredPermLog.map(log => {
              const meta = getActionMeta(log.change_type);
              return (
                <Card key={log.id} className="overflow-hidden">
                  <div className="flex items-start gap-3 p-3">
                    <div className="w-1 self-stretch rounded-full shrink-0 bg-purple-500" />
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <Badge className={`text-2xs ${meta.color}`}>{meta.label}</Badge>
                        <span className="text-2xs text-muted-foreground whitespace-nowrap">
                          {formatDate(log.created_at)}
                        </span>
                      </div>

                      <div className="flex items-center gap-4 text-xs">
                        <div className="flex items-center gap-1">
                          <User className="w-3 h-3 text-muted-foreground" />
                          <span className="text-muted-foreground">Autor:</span>
                          <span className="font-medium">{resolveName(log.changed_by)}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-muted-foreground">→ Alvo:</span>
                          <span className="font-medium">{resolveName(log.target_user_id)}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 text-2xs">
                        {log.previous_value && (
                          <>
                            <span className="text-destructive/70 line-through font-mono">{log.previous_value}</span>
                            <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          </>
                        )}
                        <span className="text-emerald-600 font-mono font-medium">{log.new_value || '—'}</span>
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </TabsContent>

          {/* ─── Margin tab ─── */}
          {(canViewStrategic || isAdmin) && (
            <TabsContent value="margin" className="mt-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold">Auditoria de Margem — Algoritmo A</CardTitle>
                  <CardDescription className="text-xs">
                    Comparativo de margem real vs. potencial por cliente. {marginLog?.length || 0} registros.
                  </CardDescription>
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
                            <td className="py-2">{resolveName(row.customer_user_id)}</td>
                            <td className="text-center py-2">R$ {Number(row.margin_real).toLocaleString('pt-BR')}</td>
                            <td className="text-center py-2">R$ {Number(row.margin_potential).toLocaleString('pt-BR')}</td>
                            <td className="text-center py-2 text-destructive font-medium">R$ {Number(row.margin_gap).toLocaleString('pt-BR')}</td>
                            <td className="text-center py-2">
                              <Badge variant={Number(row.gap_pct) > 20 ? 'destructive' : 'secondary'} className="text-2xs">
                                {Number(row.gap_pct).toFixed(1)}%
                              </Badge>
                            </td>
                            <td className="text-right py-2 text-muted-foreground">{formatDateShort(row.calculated_at)}</td>
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
