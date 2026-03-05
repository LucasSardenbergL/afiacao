import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import {
  Brain,
  Phone,
  MapPin,
  MessageSquare,
  AlertTriangle,
  TrendingDown,
  Clock,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  Zap,
  Shield,
  Target,
} from 'lucide-react';

// ─── Types ───
interface Evidence {
  label: string;
  value: string;
  type: 'warning' | 'info' | 'critical';
}

interface AIDecision {
  id: string;
  decision_type: string;
  customer_user_id: string;
  farmer_id: string | null;
  score_final: number;
  confidence: string;
  confidence_value: number;
  suggested_action: string;
  primary_reason: string;
  evidences: Evidence[];
  explanation: string;
  customer_metrics: Record<string, any>;
  status: string;
  created_at: string;
  updated_at: string;
}

// ─── Hooks ───
function useAIDecisions() {
  return useQuery({
    queryKey: ['ai-decisions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ai_decisions')
        .select('*')
        .order('score_final', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data || []) as unknown as AIDecision[];
    },
  });
}

function useCustomerProfiles(customerIds: string[]) {
  return useQuery({
    queryKey: ['ai-ops-profiles', customerIds.join(',')],
    queryFn: async () => {
      if (!customerIds.length) return [];
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, document, phone, email, customer_type')
        .in('user_id', customerIds);
      if (error) throw error;
      return data || [];
    },
    enabled: customerIds.length > 0,
  });
}

function useRunAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('ai-ops-agent');
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['ai-decisions'] });
      toast.success(`Agente executado: ${data?.decisions_generated || 0} decisões geradas`);
    },
    onError: (error) => {
      toast.error(`Erro ao executar agente: ${error.message}`);
    },
  });
}

function useUpdateDecisionStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase
        .from('ai_decisions')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-decisions'] });
    },
  });
}

// ─── Sub-components ───
const actionIcons: Record<string, React.ElementType> = {
  ligar: Phone,
  visitar: MapPin,
  mensagem: MessageSquare,
};

const actionLabels: Record<string, string> = {
  ligar: 'Ligar',
  visitar: 'Visitar',
  mensagem: 'Enviar mensagem',
};

const confidenceBadge: Record<string, { variant: 'default' | 'secondary' | 'outline' | 'destructive'; label: string }> = {
  alta: { variant: 'default', label: 'Alta' },
  media: { variant: 'secondary', label: 'Média' },
  baixa: { variant: 'outline', label: 'Baixa' },
};

function EvidenceItem({ evidence }: { evidence: Evidence }) {
  const colorMap = {
    critical: 'text-destructive',
    warning: 'text-amber-600 dark:text-amber-400',
    info: 'text-muted-foreground',
  };
  const iconMap = {
    critical: AlertTriangle,
    warning: TrendingDown,
    info: Clock,
  };
  const Icon = iconMap[evidence.type];

  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${colorMap[evidence.type]}`} />
      <div>
        <span className="font-medium">{evidence.label}:</span>{' '}
        <span className={colorMap[evidence.type]}>{evidence.value}</span>
      </div>
    </div>
  );
}

function DecisionCard({
  decision,
  customerName,
  customerPhone,
  onAccept,
  onDismiss,
}: {
  decision: AIDecision;
  customerName: string;
  customerPhone?: string | null;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ActionIcon = actionIcons[decision.suggested_action] || Phone;
  const conf = confidenceBadge[decision.confidence] || confidenceBadge.baixa;

  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardContent className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-base truncate">{customerName}</h3>
              <Badge variant={conf.variant} className="text-2xs shrink-0">
                {conf.label}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground leading-snug">{decision.primary_reason}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="text-right">
              <div className="text-lg font-bold text-primary">{decision.score_final.toFixed(0)}</div>
              <div className="text-2xs text-muted-foreground">score</div>
            </div>
          </div>
        </div>

        {/* Evidences (first 2 always visible) */}
        <div className="mt-3 space-y-1">
          {(decision.evidences as Evidence[]).slice(0, expanded ? 4 : 2).map((ev, i) => (
            <EvidenceItem key={i} evidence={ev} />
          ))}
        </div>

        {/* Actions */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="gap-1.5"
              onClick={onAccept}
              disabled={decision.status !== 'pending'}
            >
              <ActionIcon className="w-3.5 h-3.5" />
              {actionLabels[decision.suggested_action]}
            </Button>
            {decision.status === 'pending' && (
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                <XCircle className="w-3.5 h-3.5 mr-1" />
                Dispensar
              </Button>
            )}
            {decision.status === 'accepted' && (
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="w-3 h-3" /> Aceito
              </Badge>
            )}
            {decision.status === 'dismissed' && (
              <Badge variant="secondary" className="gap-1">
                <XCircle className="w-3 h-3" /> Dispensado
              </Badge>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>

        {/* Expanded metrics */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-border grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-muted-foreground text-2xs">Pedidos 90d</div>
              <div className="font-medium">{decision.customer_metrics?.pedidos_90d ?? 0}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-2xs">Faturamento 90d</div>
              <div className="font-medium">
                R$ {Number(decision.customer_metrics?.faturamento_90d ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-2xs">Ticket médio</div>
              <div className="font-medium">
                R$ {Number(decision.customer_metrics?.ticket_medio_90d ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-2xs">Intervalo médio</div>
              <div className="font-medium">
                {decision.customer_metrics?.intervalo_medio_dias
                  ? `${Math.round(decision.customer_metrics.intervalo_medio_dias)} dias`
                  : 'N/A'}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Page ───
export default function AIops() {
  const [confidenceFilter, setConfidenceFilter] = useState<string>('all');
  const [activeTab, setActiveTab] = useState('prioridades');

  const { data: decisions = [], isLoading } = useAIDecisions();
  const runAgent = useRunAgent();
  const updateStatus = useUpdateDecisionStatus();

  const customerIds = useMemo(
    () => [...new Set(decisions.map((d) => d.customer_user_id))],
    [decisions]
  );
  const { data: profiles = [] } = useCustomerProfiles(customerIds);
  const profileMap = useMemo(
    () => new Map(profiles.map((p) => [p.user_id, p])),
    [profiles]
  );

  // ─── Filtered lists ───
  const filtered = useMemo(() => {
    let list = decisions;
    if (confidenceFilter !== 'all') {
      list = list.filter((d) => d.confidence === confidenceFilter);
    }
    return list;
  }, [decisions, confidenceFilter]);

  // Prioridades: pending decisions sorted by score
  const prioridades = filtered.filter((d) => d.status === 'pending');

  // Oportunidades: customers with good metrics but could buy more (expansion)
  const oportunidades = filtered.filter(
    (d) =>
      d.status === 'pending' &&
      d.customer_metrics?.faturamento_90d > 0 &&
      (d.customer_metrics?.atraso_relativo === null ||
        d.customer_metrics?.atraso_relativo < 1.5)
  );

  // Riscos: high churn risk (atraso >= 2x or big revenue drop)
  const riscos = filtered.filter(
    (d) =>
      d.status === 'pending' &&
      (d.customer_metrics?.atraso_relativo >= 2.0 ||
        (d.customer_metrics?.faturamento_prev_90d > 0 &&
          d.customer_metrics?.faturamento_90d <
            d.customer_metrics?.faturamento_prev_90d * 0.5))
  );

  const statsCards = [
    {
      icon: Target,
      label: 'Prioridades',
      value: prioridades.length,
      color: 'text-primary',
    },
    {
      icon: Zap,
      label: 'Oportunidades',
      value: oportunidades.length,
      color: 'text-emerald-600 dark:text-emerald-400',
    },
    {
      icon: Shield,
      label: 'Riscos',
      value: riscos.length,
      color: 'text-destructive',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Brain className="w-6 h-6 text-primary" />
            AI Ops
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Inteligência operacional — decisões e recomendações automatizadas
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={confidenceFilter} onValueChange={setConfidenceFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Confiança" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              <SelectItem value="alta">Alta</SelectItem>
              <SelectItem value="media">Média</SelectItem>
              <SelectItem value="baixa">Baixa</SelectItem>
            </SelectContent>
          </Select>
          <Button
            onClick={() => runAgent.mutate()}
            disabled={runAgent.isPending}
            variant="outline"
            className="gap-1.5"
          >
            <RefreshCw className={`w-4 h-4 ${runAgent.isPending ? 'animate-spin' : ''}`} />
            Executar Agente
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {statsCards.map((s) => (
          <Card key={s.label}>
            <CardContent className="p-4 flex items-center gap-3">
              <s.icon className={`w-8 h-8 ${s.color}`} />
              <div>
                <div className="text-2xl font-bold">{s.value}</div>
                <div className="text-sm text-muted-foreground">{s.label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="prioridades" className="gap-1.5">
            <Target className="w-3.5 h-3.5" />
            Prioridades do Dia
          </TabsTrigger>
          <TabsTrigger value="oportunidades" className="gap-1.5">
            <Zap className="w-3.5 h-3.5" />
            Oportunidades
          </TabsTrigger>
          <TabsTrigger value="riscos" className="gap-1.5">
            <Shield className="w-3.5 h-3.5" />
            Riscos
          </TabsTrigger>
        </TabsList>

        {isLoading ? (
          <div className="space-y-3 mt-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        ) : (
          <>
            <TabsContent value="prioridades">
              <div className="space-y-3">
                {prioridades.length === 0 ? (
                  <Card>
                    <CardContent className="p-8 text-center text-muted-foreground">
                      <Brain className="w-12 h-12 mx-auto mb-3 opacity-30" />
                      <p>Nenhuma prioridade gerada. Execute o agente para gerar recomendações.</p>
                    </CardContent>
                  </Card>
                ) : (
                  prioridades.map((d) => (
                    <DecisionCard
                      key={d.id}
                      decision={d}
                      customerName={profileMap.get(d.customer_user_id)?.name || 'Cliente desconhecido'}
                      customerPhone={profileMap.get(d.customer_user_id)?.phone}
                      onAccept={() => updateStatus.mutate({ id: d.id, status: 'accepted' })}
                      onDismiss={() => updateStatus.mutate({ id: d.id, status: 'dismissed' })}
                    />
                  ))
                )}
              </div>
            </TabsContent>

            <TabsContent value="oportunidades">
              <div className="space-y-3">
                {oportunidades.length === 0 ? (
                  <Card>
                    <CardContent className="p-8 text-center text-muted-foreground">
                      <Zap className="w-12 h-12 mx-auto mb-3 opacity-30" />
                      <p>Nenhuma oportunidade identificada no momento.</p>
                    </CardContent>
                  </Card>
                ) : (
                  oportunidades.map((d) => (
                    <DecisionCard
                      key={d.id}
                      decision={d}
                      customerName={profileMap.get(d.customer_user_id)?.name || 'Cliente desconhecido'}
                      customerPhone={profileMap.get(d.customer_user_id)?.phone}
                      onAccept={() => updateStatus.mutate({ id: d.id, status: 'accepted' })}
                      onDismiss={() => updateStatus.mutate({ id: d.id, status: 'dismissed' })}
                    />
                  ))
                )}
              </div>
            </TabsContent>

            <TabsContent value="riscos">
              <div className="space-y-3">
                {riscos.length === 0 ? (
                  <Card>
                    <CardContent className="p-8 text-center text-muted-foreground">
                      <Shield className="w-12 h-12 mx-auto mb-3 opacity-30" />
                      <p>Nenhum cliente em risco identificado.</p>
                    </CardContent>
                  </Card>
                ) : (
                  riscos.map((d) => (
                    <DecisionCard
                      key={d.id}
                      decision={d}
                      customerName={profileMap.get(d.customer_user_id)?.name || 'Cliente desconhecido'}
                      customerPhone={profileMap.get(d.customer_user_id)?.phone}
                      onAccept={() => updateStatus.mutate({ id: d.id, status: 'accepted' })}
                      onDismiss={() => updateStatus.mutate({ id: d.id, status: 'dismissed' })}
                    />
                  ))
                )}
              </div>
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}
