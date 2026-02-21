import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/integrations/supabase/client';
import { 
  Loader2, Wrench, AlertTriangle, CheckCircle, 
  FileText, Settings, Clock, Hash 
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';

interface ToolData {
  id: string;
  internal_code: string | null;
  generated_name: string | null;
  custom_name: string | null;
  specifications: Record<string, string> | null;
  last_sharpened_at: string | null;
  next_sharpening_due: string | null;
  created_at: string;
  tool_categories: { name: string };
}

interface ToolEvent {
  id: string;
  event_type: string;
  description: string | null;
  created_at: string;
}

const EVENT_ICONS: Record<string, { label: string; icon: typeof Wrench; color: string; bg: string }> = {
  sharpening: { label: 'Afiação', icon: Wrench, color: 'text-blue-600', bg: 'bg-blue-100' },
  anomaly: { label: 'Anomalia', icon: AlertTriangle, color: 'text-red-600', bg: 'bg-red-100' },
  inspection: { label: 'Inspeção', icon: CheckCircle, color: 'text-emerald-600', bg: 'bg-emerald-100' },
  repair: { label: 'Reparo', icon: Settings, color: 'text-amber-600', bg: 'bg-amber-100' },
  note: { label: 'Observação', icon: FileText, color: 'text-gray-600', bg: 'bg-gray-100' },
};

const ToolPublicHistory = () => {
  const { toolId } = useParams<{ toolId: string }>();
  const [tool, setTool] = useState<ToolData | null>(null);
  const [events, setEvents] = useState<ToolEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (toolId) loadData();
  }, [toolId]);

  const loadData = async () => {
    try {
      const [toolRes, eventsRes] = await Promise.all([
        supabase.from('user_tools').select('*, tool_categories(name)').eq('id', toolId!).single(),
        supabase.from('tool_events').select('id, event_type, description, created_at')
          .eq('user_tool_id', toolId!).order('created_at', { ascending: false }),
      ]);
      if (toolRes.data) setTool(toolRes.data as unknown as ToolData);
      if (eventsRes.data) setEvents(eventsRes.data as ToolEvent[]);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!tool) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <Wrench className="w-16 h-16 text-muted-foreground mb-4" />
        <h1 className="text-xl font-bold text-foreground">Ferramenta não encontrada</h1>
        <p className="text-muted-foreground mt-2">O QR code pode estar desatualizado</p>
      </div>
    );
  }

  const displayName = tool.generated_name || tool.custom_name || tool.tool_categories?.name;
  const sharpeningCount = events.filter(e => e.event_type === 'sharpening').length;

  return (
    <div className="min-h-screen bg-background p-4 max-w-lg mx-auto">
      {/* Header */}
      <div className="text-center mb-6 pt-4">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
          <Wrench className="w-8 h-8 text-primary" />
        </div>
        <h1 className="text-xl font-bold text-foreground">{displayName}</h1>
        {tool.internal_code && (
          <div className="flex items-center justify-center gap-1.5 mt-1">
            <Hash className="w-4 h-4 text-muted-foreground" />
            <span className="font-mono font-bold text-primary">{tool.internal_code}</span>
          </div>
        )}
        <p className="text-sm text-muted-foreground mt-1">{tool.tool_categories?.name}</p>
      </div>

      {/* Specs */}
      {tool.specifications && Object.keys(tool.specifications).length > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5 mb-4">
          {Object.entries(tool.specifications).map(([k, v]) => (
            <Badge key={k} variant="secondary" className="text-xs">{v}</Badge>
          ))}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-primary">{sharpeningCount}</p>
            <p className="text-xs text-muted-foreground">Afiações</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-foreground">
              {tool.last_sharpened_at 
                ? format(new Date(tool.last_sharpened_at), "dd/MM/yy", { locale: ptBR })
                : 'N/A'}
            </p>
            <p className="text-xs text-muted-foreground">Última afiação</p>
          </CardContent>
        </Card>
      </div>

      {/* Events */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Histórico</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {events.length > 0 ? (
            <div className="relative">
              <div className="absolute left-5 top-2 bottom-2 w-px bg-border" />
              <div className="space-y-4">
                {events.map((event) => {
                  const cfg = EVENT_ICONS[event.event_type] || EVENT_ICONS.note;
                  const Icon = cfg.icon;
                  return (
                    <div key={event.id} className="relative flex gap-3 pl-1">
                      <div className={cn('w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 z-10', cfg.bg)}>
                        <Icon className={cn('w-4 h-4', cfg.color)} />
                      </div>
                      <div className="flex-1 pt-1">
                        <div className="flex items-center gap-2">
                          <span className={cn('text-sm font-medium', cfg.color)}>{cfg.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(event.created_at), "dd/MM/yy HH:mm", { locale: ptBR })}
                          </span>
                        </div>
                        {event.description && (
                          <p className="text-sm text-muted-foreground mt-0.5">{event.description}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="text-center py-6">
              <Clock className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">Sem eventos registrados</p>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-center text-xs text-muted-foreground mt-6">
        Colacor • Histórico de Ferramenta
      </p>
    </div>
  );
};

export default ToolPublicHistory;
