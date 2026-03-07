import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AddToolDialog } from '@/components/AddToolDialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plus, Wrench, Calendar, Trash2, Hash, Users, AlertTriangle, ShieldCheck, Clock, HelpCircle } from 'lucide-react';
import { differenceInDays, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useUserTools, useToolCategories } from '@/queries/useUserTools';
import { useQueryClient } from '@tanstack/react-query';

type Criticality = 'critical' | 'attention' | 'healthy' | 'unscheduled';

const CRITICALITY_CONFIG: Record<Criticality, {
  label: string;
  icon: typeof AlertTriangle;
  badgeClass: string;
  iconClass: string;
  bgClass: string;
  sortOrder: number;
}> = {
  critical: {
    label: 'Crítica',
    icon: AlertTriangle,
    badgeClass: 'border-destructive/40 bg-destructive/10 text-destructive',
    iconClass: 'text-destructive',
    bgClass: 'bg-destructive/10',
    sortOrder: 0,
  },
  attention: {
    label: 'Atenção',
    icon: Clock,
    badgeClass: 'border-status-warning/40 bg-status-warning-bg text-status-warning',
    iconClass: 'text-status-warning',
    bgClass: 'bg-status-warning-bg',
    sortOrder: 1,
  },
  healthy: {
    label: 'Saudável',
    icon: ShieldCheck,
    badgeClass: 'border-emerald-400/40 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300',
    iconClass: 'text-emerald-600 dark:text-emerald-400',
    bgClass: 'bg-emerald-50 dark:bg-emerald-900/20',
    sortOrder: 2,
  },
  unscheduled: {
    label: 'Não agendada',
    icon: HelpCircle,
    badgeClass: 'border-border bg-muted text-muted-foreground',
    iconClass: 'text-muted-foreground',
    bgClass: 'bg-muted',
    sortOrder: 3,
  },
};

function getCriticality(nextDue: string | null): Criticality {
  if (!nextDue) return 'unscheduled';
  const days = differenceInDays(new Date(nextDue), new Date());
  if (days < 0) return 'critical';
  if (days <= 7) return 'attention';
  return 'healthy';
}

const Tools = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isStaff } = useUserRole();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: tools = [], isLoading: loading } = useUserTools(user?.id);
  const { data: categories = [] } = useToolCategories();
  const [dialogOpen, setDialogOpen] = useState(false);

  // Sorted tools + counts
  const { sorted, counts } = useMemo(() => {
    const withCrit = tools.map(t => ({
      ...t,
      criticality: getCriticality(t.next_sharpening_due),
    }));
    withCrit.sort((a, b) => CRITICALITY_CONFIG[a.criticality].sortOrder - CRITICALITY_CONFIG[b.criticality].sortOrder);

    const c = { critical: 0, attention: 0, healthy: 0, unscheduled: 0 };
    withCrit.forEach(t => c[t.criticality]++);
    return { sorted: withCrit, counts: c };
  }, [tools]);

  const urgentCount = counts.critical + counts.attention;

  const handleDeleteTool = async (toolId: string) => {
    try {
      const { error } = await supabase.from('user_tools').delete().eq('id', toolId);
      if (error) throw error;
      toast({ title: 'Ferramenta removida' });
      queryClient.invalidateQueries({ queryKey: ['user-tools', user?.id] });
    } catch {
      toast({ title: 'Erro ao remover', variant: 'destructive' });
    }
  };

  const handleToolAdded = () => queryClient.invalidateQueries({ queryKey: ['user-tools', user?.id] });

  const getToolDisplayName = (tool: typeof tools[number]): string =>
    tool.generated_name || tool.custom_name || tool.tool_categories?.name || 'Ferramenta';

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Minhas Ferramentas" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  if (isStaff) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Ferramentas" showBack />
        <main className="pt-16 px-4 max-w-lg mx-auto">
          <div className="text-center py-12">
            <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <Users className="w-10 h-10 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-foreground mb-2">Gestão de Ferramentas</h3>
            <p className="text-sm text-muted-foreground mb-6 max-w-xs mx-auto">
              Como funcionário, as ferramentas são cadastradas para os clientes.
            </p>
            <div className="space-y-3">
              <Button onClick={() => navigate('/admin/customers')} className="w-full">
                <Users className="w-4 h-4 mr-2" />
                Gestão de Clientes
              </Button>
              <Button variant="outline" onClick={() => navigate('/new-order')} className="w-full">
                <Plus className="w-4 h-4 mr-2" />
                Novo Pedido
              </Button>
            </div>
          </div>
        </main>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header
        title="Minhas Ferramentas"
        showBack
        rightElement={
          <Button size="icon" variant="ghost" className="rounded-full" onClick={() => setDialogOpen(true)}>
            <Plus className="w-5 h-5" />
          </Button>
        }
      />

      <AddToolDialog open={dialogOpen} onOpenChange={setDialogOpen} onToolAdded={handleToolAdded} categories={categories} />

      <main className="pt-16 px-4 max-w-lg mx-auto">

        {tools.length > 0 ? (
          <>
            {/* ═══ URGENT ALERT ═══ */}
            {urgentCount > 0 && (
              <Card className="mb-4 border-status-warning/50 ring-1 ring-status-warning/20 overflow-hidden">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-status-warning-bg flex items-center justify-center flex-shrink-0">
                      <AlertTriangle className="w-5 h-5 text-status-warning" />
                    </div>
                    <div className="flex-1">
                      <p className="font-semibold text-foreground text-sm">
                        {urgentCount === 1
                          ? 'Você tem 1 ferramenta que precisa de afiação'
                          : `Você tem ${urgentCount} ferramentas que precisam de afiação`}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {counts.critical > 0 && `${counts.critical} vencida${counts.critical > 1 ? 's' : ''}`}
                        {counts.critical > 0 && counts.attention > 0 && ' · '}
                        {counts.attention > 0 && `${counts.attention} próxima${counts.attention > 1 ? 's' : ''} do prazo`}
                      </p>
                    </div>
                  </div>
                  <Button
                    className="w-full mt-3 gap-2"
                    size="sm"
                    onClick={() => navigate('/new-order')}
                  >
                    <Wrench className="w-4 h-4" />
                    Criar pedido de afiação
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* ═══ SUMMARY ═══ */}
            <div className="grid grid-cols-4 gap-2 mb-5">
              <SummaryPill value={tools.length} label="Total" className="text-foreground" />
              <SummaryPill value={counts.critical} label="Críticas" className="text-destructive" />
              <SummaryPill value={counts.attention} label="Atenção" className="text-status-warning" />
              <SummaryPill value={counts.healthy} label="Saudáveis" className="text-emerald-600 dark:text-emerald-400" />
            </div>

            {/* ═══ TOOLS LIST ═══ */}
            <div className="space-y-3">
              {sorted.map((tool) => {
                const config = CRITICALITY_CONFIG[tool.criticality];
                const CritIcon = config.icon;
                const daysUntilDue = tool.next_sharpening_due
                  ? differenceInDays(new Date(tool.next_sharpening_due), new Date())
                  : null;
                const displayName = getToolDisplayName(tool);

                return (
                  <Card
                    key={tool.id}
                    className={cn(
                      'overflow-hidden cursor-pointer hover:border-primary/50 transition-colors',
                      tool.criticality === 'critical' && 'border-destructive/30',
                      tool.criticality === 'attention' && 'border-status-warning/30'
                    )}
                    onClick={() => navigate(`/tools/${tool.id}`)}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className={cn('w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0', config.bgClass)}>
                          <Wrench className={cn('w-6 h-6', config.iconClass)} />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <h3 className="font-semibold text-foreground text-sm leading-tight">{displayName}</h3>
                              {tool.generated_name && (
                                <p className="text-xs text-muted-foreground mt-0.5">{tool.tool_categories?.name}</p>
                              )}
                              {tool.internal_code && (
                                <div className="flex items-center gap-1 mt-0.5">
                                  <Hash className="w-3 h-3 text-muted-foreground" />
                                  <span className="text-xs font-mono font-semibold text-primary">{tool.internal_code}</span>
                                </div>
                              )}
                            </div>
                            <Badge variant="outline" className={cn('text-[10px] font-semibold px-2 py-0.5 flex-shrink-0 gap-1', config.badgeClass)}>
                              <CritIcon className="w-3 h-3" />
                              {config.label}
                            </Badge>
                          </div>

                          {/* Details row */}
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                            {tool.quantity && tool.quantity > 1 && <span>Qtd: {tool.quantity}</span>}
                            {tool.last_sharpened_at && (
                              <span>Última: {format(new Date(tool.last_sharpened_at), 'dd/MM/yy', { locale: ptBR })}</span>
                            )}
                            {tool.next_sharpening_due && (
                              <span className="flex items-center gap-1">
                                <Calendar className="w-3 h-3" />
                                {daysUntilDue !== null && daysUntilDue < 0
                                  ? `${Math.abs(daysUntilDue)}d atrasado`
                                  : daysUntilDue === 0
                                    ? 'Hoje'
                                    : `Em ${daysUntilDue}d`}
                              </span>
                            )}
                            {tool.sharpening_interval_days && (
                              <span>Intervalo: {tool.sharpening_interval_days}d</span>
                            )}
                          </div>
                        </div>

                        <Button
                          size="icon"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive flex-shrink-0"
                          onClick={(e) => { e.stopPropagation(); handleDeleteTool(tool.id); }}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </>
        ) : (
          /* ═══ EMPTY STATE ═══ */
          <div className="text-center py-12">
            <div className="w-20 h-20 bg-muted rounded-full flex items-center justify-center mx-auto mb-4">
              <Wrench className="w-10 h-10 text-muted-foreground" />
            </div>
            <h3 className="font-display font-bold text-foreground mb-2">Cadastre suas ferramentas</h3>
            <p className="text-sm text-muted-foreground mb-6 max-w-xs mx-auto">
              Com suas ferramentas cadastradas, você recebe lembretes de afiação no momento certo e cria pedidos com muito mais rapidez.
            </p>
            <Button onClick={() => setDialogOpen(true)} className="gap-2">
              <Plus className="w-4 h-4" />
              Cadastrar primeira ferramenta
            </Button>
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

export default Tools;

/* ─── Sub-components ─── */

function SummaryPill({ value, label, className }: { value: number; label: string; className?: string }) {
  return (
    <div className="bg-card rounded-xl p-3 border border-border text-center">
      <p className={cn('text-xl font-bold', className)}>{value}</p>
      <p className="text-[10px] text-muted-foreground font-medium">{label}</p>
    </div>
  );
}
