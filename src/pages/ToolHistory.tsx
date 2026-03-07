import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import {
  Loader2, Wrench, Calendar, QrCode, Printer,
  AlertTriangle, CheckCircle, FileText, Settings,
  Clock, Hash, BarChart3, ShieldCheck, HelpCircle,
  ArrowRight, TrendingUp
} from 'lucide-react';
import { format, formatDistanceToNow, differenceInDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { QRCodeSVG } from 'qrcode.react';
import { cn } from '@/lib/utils';

/* ─── Types ─── */

interface ToolData {
  id: string;
  internal_code: string | null;
  custom_name: string | null;
  generated_name: string | null;
  quantity: number | null;
  specifications: Record<string, string> | null;
  sharpening_interval_days: number | null;
  last_sharpened_at: string | null;
  next_sharpening_due: string | null;
  created_at: string;
  tool_categories: {
    name: string;
    description: string | null;
    suggested_interval_days: number | null;
  };
}

interface ToolEvent {
  id: string;
  event_type: string;
  description: string | null;
  metadata: Record<string, any> | null;
  order_id: string | null;
  created_at: string;
}

/* ─── Criticality (shared logic with Tools.tsx) ─── */

type Criticality = 'critical' | 'attention' | 'healthy' | 'unscheduled';

const CRITICALITY_CONFIG: Record<Criticality, {
  label: string; icon: typeof AlertTriangle; badgeClass: string; iconClass: string; bgClass: string;
}> = {
  critical: { label: 'Crítica', icon: AlertTriangle, badgeClass: 'border-destructive/40 bg-destructive/10 text-destructive', iconClass: 'text-destructive', bgClass: 'bg-destructive/10' },
  attention: { label: 'Atenção', icon: Clock, badgeClass: 'border-status-warning/40 bg-status-warning-bg text-status-warning', iconClass: 'text-status-warning', bgClass: 'bg-status-warning-bg' },
  healthy: { label: 'Saudável', icon: ShieldCheck, badgeClass: 'border-emerald-400/40 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300', iconClass: 'text-emerald-600 dark:text-emerald-400', bgClass: 'bg-emerald-50 dark:bg-emerald-900/20' },
  unscheduled: { label: 'Não agendada', icon: HelpCircle, badgeClass: 'border-border bg-muted text-muted-foreground', iconClass: 'text-muted-foreground', bgClass: 'bg-muted' },
};

function getCriticality(nextDue: string | null): Criticality {
  if (!nextDue) return 'unscheduled';
  const days = differenceInDays(new Date(nextDue), new Date());
  if (days < 0) return 'critical';
  if (days <= 7) return 'attention';
  return 'healthy';
}

/* ─── Event type config ─── */

const EVENT_TYPE_CONFIG: Record<string, { label: string; icon: typeof Wrench; color: string; bg: string; sortWeight: number }> = {
  anomaly: { label: 'Anomalia', icon: AlertTriangle, color: 'text-destructive', bg: 'bg-destructive/10', sortWeight: 0 },
  sharpening: { label: 'Afiação', icon: Wrench, color: 'text-primary', bg: 'bg-primary/10', sortWeight: 1 },
  inspection: { label: 'Inspeção', icon: CheckCircle, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20', sortWeight: 2 },
  repair: { label: 'Reparo', icon: Settings, color: 'text-status-warning', bg: 'bg-status-warning-bg', sortWeight: 3 },
  note: { label: 'Observação', icon: FileText, color: 'text-muted-foreground', bg: 'bg-muted', sortWeight: 4 },
};

/* ─── Recommendation engine ─── */

interface Recommendation {
  title: string;
  description: string;
  variant: 'destructive' | 'warning' | 'info' | 'success';
}

function computeRecommendation(criticality: Criticality, sharpeningEvents: ToolEvent[], intervalDays: number): Recommendation {
  if (criticality === 'critical') {
    return { title: 'Afiação urgente', description: 'Ferramenta com prazo vencido — agende imediatamente.', variant: 'destructive' };
  }
  if (criticality === 'attention') {
    return { title: 'Afiar em breve', description: 'A próxima afiação está chegando — agende sua manutenção.', variant: 'warning' };
  }

  // Check for intensive usage pattern
  if (sharpeningEvents.length >= 3) {
    const intervals: number[] = [];
    for (let i = 0; i < sharpeningEvents.length - 1; i++) {
      intervals.push(Math.abs(differenceInDays(new Date(sharpeningEvents[i].created_at), new Date(sharpeningEvents[i + 1].created_at))));
    }
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (avgInterval < intervalDays * 0.7) {
      return { title: 'Uso intenso detectado', description: 'O intervalo real está menor que o recomendado — considere revisar a frequência.', variant: 'info' };
    }
  }

  if (criticality === 'healthy') {
    return { title: 'Manter rotina atual', description: 'Ferramenta bem cuidada — continue afiando no prazo recomendado.', variant: 'success' };
  }

  return { title: 'Cadastre a primeira afiação', description: 'Sem dados suficientes para recomendar — crie um pedido para começar o acompanhamento.', variant: 'info' };
}

const RECOMMENDATION_STYLES: Record<string, { border: string; bg: string; icon: typeof AlertTriangle; iconClass: string }> = {
  destructive: { border: 'border-destructive/40', bg: 'bg-destructive/5', icon: AlertTriangle, iconClass: 'text-destructive' },
  warning: { border: 'border-status-warning/40', bg: 'bg-status-warning-bg/50', icon: Clock, iconClass: 'text-status-warning' },
  info: { border: 'border-primary/30', bg: 'bg-primary/5', icon: TrendingUp, iconClass: 'text-primary' },
  success: { border: 'border-emerald-400/30', bg: 'bg-emerald-50 dark:bg-emerald-900/10', icon: ShieldCheck, iconClass: 'text-emerald-600 dark:text-emerald-400' },
};

/* ═══════════════════════════════════════════════
   Main Component
   ═══════════════════════════════════════════════ */

const ToolHistory = () => {
  const { toolId } = useParams<{ toolId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [tool, setTool] = useState<ToolData | null>(null);
  const [events, setEvents] = useState<ToolEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showQR, setShowQR] = useState(false);
  const qrRef = useRef<HTMLDivElement>(null);

  const publicUrl = `${window.location.origin}/tool/${toolId}`;

  useEffect(() => {
    if (toolId) loadTool();
  }, [toolId]);

  const loadTool = async () => {
    try {
      const [toolRes, eventsRes] = await Promise.all([
        supabase.from('user_tools').select('*, tool_categories(*)').eq('id', toolId!).single(),
        supabase.from('tool_events').select('*').eq('user_tool_id', toolId!).order('created_at', { ascending: false }),
      ]);
      if (toolRes.data) setTool(toolRes.data as unknown as ToolData);
      if (eventsRes.data) setEvents(eventsRes.data as ToolEvent[]);
    } catch (error) {
      console.error('Error loading tool:', error);
    } finally {
      setLoading(false);
    }
  };

  const handlePrintQR = () => {
    if (!qrRef.current || !tool) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    const svgElement = qrRef.current.querySelector('svg');
    if (!svgElement) return;
    printWindow.document.write(`<!DOCTYPE html><html><head><title>QR Code - ${tool.internal_code}</title>
      <style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:monospace}
      .code{font-size:18px;font-weight:bold;margin-top:12px;letter-spacing:2px}.name{font-size:12px;color:#666;margin-top:4px}
      @media print{body{padding:0}}</style></head><body>${svgElement.outerHTML}
      <div class="code">${tool.internal_code}</div><div class="name">${tool.generated_name || tool.tool_categories?.name}</div>
      <script>window.print();window.close();</script></body></html>`);
    printWindow.document.close();
  };

  /* ─── Derived data ─── */
  const sharpeningEvents = useMemo(() => events.filter(e => e.event_type === 'sharpening'), [events]);
  const anomalyCount = useMemo(() => events.filter(e => e.event_type === 'anomaly').length, [events]);

  const healthMetrics = useMemo(() => {
    if (!tool) return null;
    const criticality = getCriticality(tool.next_sharpening_due);
    const intervalDays = tool.sharpening_interval_days || tool.tool_categories?.suggested_interval_days || 90;

    // Average interval between sharpenings
    let avgInterval: number | null = null;
    if (sharpeningEvents.length >= 2) {
      const intervals: number[] = [];
      for (let i = 0; i < sharpeningEvents.length - 1; i++) {
        intervals.push(Math.abs(differenceInDays(new Date(sharpeningEvents[i].created_at), new Date(sharpeningEvents[i + 1].created_at))));
      }
      avgInterval = Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);
    }

    // Days since last sharpening
    const daysSinceLast = tool.last_sharpened_at
      ? differenceInDays(new Date(), new Date(tool.last_sharpened_at))
      : null;

    // Accumulated cost from event metadata
    let accumulatedCost = 0;
    sharpeningEvents.forEach(e => {
      if (e.metadata && typeof e.metadata === 'object' && 'cost' in e.metadata) {
        accumulatedCost += Number(e.metadata.cost) || 0;
      }
    });

    const recommendation = computeRecommendation(criticality, sharpeningEvents, intervalDays);

    return { criticality, avgInterval, daysSinceLast, accumulatedCost, recommendation, intervalDays };
  }, [tool, sharpeningEvents]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Histórico" showBack />
        <div className="flex items-center justify-center pt-32"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        <BottomNav />
      </div>
    );
  }

  if (!tool || !healthMetrics) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Ferramenta" showBack />
        <div className="text-center py-20">
          <Wrench className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">Ferramenta não encontrada</p>
        </div>
        <BottomNav />
      </div>
    );
  }

  const displayName = tool.generated_name || tool.custom_name || tool.tool_categories?.name || 'Ferramenta';
  const critConfig = CRITICALITY_CONFIG[healthMetrics.criticality];
  const CritIcon = critConfig.icon;
  const recStyle = RECOMMENDATION_STYLES[healthMetrics.recommendation.variant];
  const RecIcon = recStyle.icon;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header
        title={tool.internal_code || 'Ferramenta'}
        showBack
        rightElement={
          <Button size="icon" variant="ghost" onClick={() => setShowQR(!showQR)}>
            <QrCode className="w-5 h-5" />
          </Button>
        }
      />

      <main className="pt-16 px-4 max-w-lg mx-auto space-y-4">

        {/* ═══ TOOL INFO ═══ */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className={cn('w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0', critConfig.bgClass)}>
                <Wrench className={cn('w-7 h-7', critConfig.iconClass)} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="font-bold text-foreground text-lg leading-tight">{displayName}</h2>
                    <p className="text-sm text-muted-foreground">{tool.tool_categories?.name}</p>
                  </div>
                  <Badge variant="outline" className={cn('text-[10px] font-semibold px-2 py-0.5 gap-1 flex-shrink-0', critConfig.badgeClass)}>
                    <CritIcon className="w-3 h-3" />
                    {critConfig.label}
                  </Badge>
                </div>
                {tool.internal_code && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <Hash className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs font-mono font-semibold text-primary">{tool.internal_code}</span>
                  </div>
                )}
              </div>
            </div>
            {tool.specifications && Object.keys(tool.specifications).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {Object.entries(tool.specifications).map(([key, value]) => (
                  <Badge key={key} variant="secondary" className="text-xs">{value}</Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ═══ HEALTH PANEL ═══ */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary" />
              Painel de Saúde
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="grid grid-cols-2 gap-3">
              <HealthStat label="Total de afiações" value={String(sharpeningEvents.length)} />
              <HealthStat
                label="Intervalo médio"
                value={healthMetrics.avgInterval !== null ? `${healthMetrics.avgInterval}d` : '—'}
                sub={`Recomendado: ${healthMetrics.intervalDays}d`}
              />
              <HealthStat
                label="Desde última afiação"
                value={healthMetrics.daysSinceLast !== null ? `${healthMetrics.daysSinceLast}d` : '—'}
              />
              <HealthStat
                label="Custo acumulado"
                value={healthMetrics.accumulatedCost > 0
                  ? `R$ ${healthMetrics.accumulatedCost.toFixed(2).replace('.', ',')}`
                  : '—'}
              />
            </div>
          </CardContent>
        </Card>

        {/* ═══ RECOMMENDATION ═══ */}
        <Card className={cn('border', recStyle.border, recStyle.bg)}>
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-card flex items-center justify-center flex-shrink-0">
                <RecIcon className={cn('w-5 h-5', recStyle.iconClass)} />
              </div>
              <div className="flex-1">
                <h4 className="font-semibold text-foreground text-sm">{healthMetrics.recommendation.title}</h4>
                <p className="text-xs text-muted-foreground mt-0.5">{healthMetrics.recommendation.description}</p>
              </div>
            </div>
            {(healthMetrics.criticality === 'critical' || healthMetrics.criticality === 'attention' || healthMetrics.criticality === 'unscheduled') && (
              <Button size="sm" className="w-full mt-3 gap-2" onClick={() => navigate('/new-order')}>
                <Wrench className="w-4 h-4" />
                Agendar afiação
              </Button>
            )}
          </CardContent>
        </Card>

        {/* ═══ QR CODE ═══ */}
        {showQR && (
          <Card>
            <CardContent className="p-6 flex flex-col items-center">
              <div ref={qrRef}>
                <QRCodeSVG value={publicUrl} size={200} level="H" includeMargin />
              </div>
              <p className="text-sm font-mono font-bold text-foreground mt-3">{tool.internal_code}</p>
              <p className="text-xs text-muted-foreground mt-1 text-center">Escaneie para acessar o histórico desta ferramenta</p>
              <Button variant="outline" className="mt-4" onClick={handlePrintQR}>
                <Printer className="w-4 h-4 mr-2" />
                Imprimir QR Code
              </Button>
            </CardContent>
          </Card>
        )}

        {/* ═══ DETAILS ═══ */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <DetailRow label="Última afiação" value={tool.last_sharpened_at ? format(new Date(tool.last_sharpened_at), 'dd/MM/yyyy', { locale: ptBR }) : 'Nunca afiada'} />
            <Separator />
            <DetailRow label="Próxima afiação" value={tool.next_sharpening_due ? format(new Date(tool.next_sharpening_due), 'dd/MM/yyyy', { locale: ptBR }) : 'Não definida'} />
            <Separator />
            <DetailRow label="Intervalo" value={`${healthMetrics.intervalDays} dias`} />
            {tool.quantity && tool.quantity > 1 && (<><Separator /><DetailRow label="Quantidade" value={`${tool.quantity} un.`} /></>)}
            <Separator />
            <DetailRow label="Cadastrada em" value={format(new Date(tool.created_at), 'dd/MM/yyyy', { locale: ptBR })} />
          </CardContent>
        </Card>

        {/* Reports link */}
        <Button variant="outline" className="w-full gap-2" onClick={() => navigate(`/tools/${toolId}/reports`)}>
          <BarChart3 className="w-4 h-4" />
          Ver Relatório Completo
        </Button>

        {/* ═══ EVENT TIMELINE ═══ */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Histórico de Eventos</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {events.length > 0 ? (
              <div className="relative">
                <div className="absolute left-5 top-2 bottom-2 w-px bg-border" />
                <div className="space-y-4">
                  {events.map((event) => {
                    const config = EVENT_TYPE_CONFIG[event.event_type] || EVENT_TYPE_CONFIG.note;
                    const Icon = config.icon;
                    const isAnomaly = event.event_type === 'anomaly';

                    return (
                      <div key={event.id} className={cn('relative flex gap-3 pl-1', isAnomaly && 'bg-destructive/5 -mx-2 px-3 py-2 rounded-lg')}>
                        <div className={cn('w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 z-10', config.bg)}>
                          <Icon className={cn('w-4 h-4', config.color)} />
                        </div>
                        <div className="flex-1 min-w-0 pt-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={cn('text-sm font-semibold', config.color)}>{config.label}</span>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(event.created_at), "dd/MM/yy 'às' HH:mm", { locale: ptBR })}
                            </span>
                          </div>
                          {event.description && (
                            <p className="text-sm text-muted-foreground mt-0.5">{event.description}</p>
                          )}
                          {event.order_id && (
                            <button
                              onClick={() => navigate(`/orders/${event.order_id}`)}
                              className="text-xs text-primary hover:underline mt-1 flex items-center gap-1"
                            >
                              Ver pedido vinculado <ArrowRight className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <Clock className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">Nenhum evento registrado ainda</p>
                <p className="text-xs text-muted-foreground mt-1">O histórico será atualizado automaticamente com pedidos e inspeções</p>
              </div>
            )}
          </CardContent>
        </Card>
      </main>

      <BottomNav />
    </div>
  );
};

export default ToolHistory;

/* ─── Sub-components ─── */

function HealthStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-muted/50 rounded-xl p-3">
      <p className="text-lg font-bold text-foreground">{value}</p>
      <p className="text-[10px] text-muted-foreground font-medium">{label}</p>
      {sub && <p className="text-[9px] text-muted-foreground/70 mt-0.5">{sub}</p>}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}
