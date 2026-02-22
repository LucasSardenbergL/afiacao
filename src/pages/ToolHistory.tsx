import { useState, useEffect, useRef } from 'react';
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
  Clock, Hash, ChevronDown, ChevronUp, BarChart3 
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { QRCodeSVG } from 'qrcode.react';
import { cn } from '@/lib/utils';

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

const EVENT_TYPE_CONFIG: Record<string, { label: string; icon: typeof Wrench; color: string; bg: string }> = {
  sharpening: { label: 'Afiação', icon: Wrench, color: 'text-primary', bg: 'bg-primary/10' },
  anomaly: { label: 'Anomalia', icon: AlertTriangle, color: 'text-destructive', bg: 'bg-destructive/10' },
  inspection: { label: 'Inspeção', icon: CheckCircle, color: 'text-emerald-600', bg: 'bg-emerald-100' },
  repair: { label: 'Reparo', icon: Settings, color: 'text-amber-600', bg: 'bg-amber-100' },
  note: { label: 'Observação', icon: FileText, color: 'text-muted-foreground', bg: 'bg-muted' },
};

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
        supabase
          .from('user_tools')
          .select('*, tool_categories(*)')
          .eq('id', toolId!)
          .single(),
        supabase
          .from('tool_events')
          .select('*')
          .eq('user_tool_id', toolId!)
          .order('created_at', { ascending: false }),
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

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head><title>QR Code - ${tool.internal_code}</title>
        <style>
          body { display: flex; flex-direction: column; align-items: center; justify-content: center; 
                 min-height: 100vh; margin: 0; font-family: monospace; }
          .code { font-size: 18px; font-weight: bold; margin-top: 12px; letter-spacing: 2px; }
          .name { font-size: 12px; color: #666; margin-top: 4px; }
          @media print { body { padding: 0; } }
        </style></head>
        <body>
          ${svgElement.outerHTML}
          <div class="code">${tool.internal_code}</div>
          <div class="name">${tool.generated_name || tool.tool_categories?.name}</div>
          <script>window.print(); window.close();</script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  const sharpeningCount = events.filter(e => e.event_type === 'sharpening').length;
  const anomalyCount = events.filter(e => e.event_type === 'anomaly').length;
  const lastSharpening = events.find(e => e.event_type === 'sharpening');

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Histórico" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  if (!tool) {
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
        {/* Tool info card */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Wrench className="w-7 h-7 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-bold text-foreground text-lg leading-tight">{displayName}</h2>
                <p className="text-sm text-muted-foreground">{tool.tool_categories?.name}</p>
                {tool.internal_code && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <Hash className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-xs font-mono font-semibold text-primary">{tool.internal_code}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Specs */}
            {tool.specifications && Object.keys(tool.specifications).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {Object.entries(tool.specifications).map(([key, value]) => (
                  <Badge key={key} variant="secondary" className="text-xs">
                    {value}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* QR Code section */}
        {showQR && (
          <Card>
            <CardContent className="p-6 flex flex-col items-center">
              <div ref={qrRef}>
                <QRCodeSVG
                  value={publicUrl}
                  size={200}
                  level="H"
                  includeMargin
                />
              </div>
              <p className="text-sm font-mono font-bold text-foreground mt-3">{tool.internal_code}</p>
              <p className="text-xs text-muted-foreground mt-1 text-center">
                Escaneie para acessar o histórico desta ferramenta
              </p>
              <Button variant="outline" className="mt-4" onClick={handlePrintQR}>
                <Printer className="w-4 h-4 mr-2" />
                Imprimir QR Code
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Reports link */}
        <Button variant="outline" className="w-full gap-2" onClick={() => navigate(`/tools/${toolId}/reports`)}>
          <BarChart3 className="w-4 h-4" />
          Ver Relatório Completo
        </Button>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-2xl font-bold text-primary">{sharpeningCount}</p>
              <p className="text-xs text-muted-foreground">Afiações</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-2xl font-bold text-destructive">{anomalyCount}</p>
              <p className="text-xs text-muted-foreground">Anomalias</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-2xl font-bold text-foreground">
                {tool.created_at ? formatDistanceToNow(new Date(tool.created_at), { locale: ptBR, addSuffix: false }) : '-'}
              </p>
              <p className="text-xs text-muted-foreground">Idade</p>
            </CardContent>
          </Card>
        </div>

        {/* Status info */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Última afiação</span>
              <span className="text-sm font-medium text-foreground">
                {tool.last_sharpened_at 
                  ? format(new Date(tool.last_sharpened_at), "dd/MM/yyyy", { locale: ptBR })
                  : 'Nunca afiada'}
              </span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Próxima afiação</span>
              <span className="text-sm font-medium text-foreground">
                {tool.next_sharpening_due
                  ? format(new Date(tool.next_sharpening_due), "dd/MM/yyyy", { locale: ptBR })
                  : 'Não definida'}
              </span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Intervalo</span>
              <span className="text-sm font-medium text-foreground">
                {tool.sharpening_interval_days || tool.tool_categories?.suggested_interval_days || 90} dias
              </span>
            </div>
            {tool.quantity && tool.quantity > 1 && (
              <>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Quantidade</span>
                  <span className="text-sm font-medium text-foreground">{tool.quantity} un.</span>
                </div>
              </>
            )}
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Cadastrada em</span>
              <span className="text-sm font-medium text-foreground">
                {format(new Date(tool.created_at), "dd/MM/yyyy", { locale: ptBR })}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Timeline */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Histórico de Eventos</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            {events.length > 0 ? (
              <div className="relative">
                {/* Timeline line */}
                <div className="absolute left-5 top-2 bottom-2 w-px bg-border" />
                
                <div className="space-y-4">
                  {events.map((event) => {
                    const config = EVENT_TYPE_CONFIG[event.event_type] || EVENT_TYPE_CONFIG.note;
                    const Icon = config.icon;

                    return (
                      <div key={event.id} className="relative flex gap-3 pl-1">
                        <div className={cn(
                          'w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 z-10',
                          config.bg
                        )}>
                          <Icon className={cn('w-4 h-4', config.color)} />
                        </div>
                        <div className="flex-1 min-w-0 pt-1">
                          <div className="flex items-center gap-2">
                            <span className={cn('text-sm font-medium', config.color)}>
                              {config.label}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(event.created_at), "dd/MM/yy HH:mm", { locale: ptBR })}
                            </span>
                          </div>
                          {event.description && (
                            <p className="text-sm text-muted-foreground mt-0.5">{event.description}</p>
                          )}
                          {event.order_id && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Pedido vinculado
                            </p>
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
                <p className="text-xs text-muted-foreground mt-1">
                  O histórico será atualizado automaticamente com pedidos e inspeções
                </p>
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
