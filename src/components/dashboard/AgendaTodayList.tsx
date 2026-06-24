import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Phone, AlertTriangle, TrendingUp, Clock, Loader2, UserPlus } from 'lucide-react';
import { useMyAgendaToday, type AgendaItem } from '@/hooks/useMyAgendaToday';
import { useWebRTCCallContext } from '@/contexts/webrtc-call-context';
import { toast } from 'sonner';
import { SignalModifierBadge } from './SignalModifierBadge';

const AGENDA_META: Record<AgendaItem['agenda_type'], { label: string; icon: typeof Phone; color: string }> = {
  risco: { label: 'Risco', icon: AlertTriangle, color: 'text-status-error' },
  expansao: { label: 'Expansão', icon: TrendingUp, color: 'text-status-success' },
  ativacao: { label: 'Ativação', icon: UserPlus, color: 'text-muted-foreground' },
  follow_up: { label: 'Follow-up', icon: Clock, color: 'text-status-info' },
};

/**
 * Lista priorizada da agenda do dia do vendedor (top N de farmer_client_scores
 * filtrado por priority_score). Cada item tem botão "Ligar agora" que dispara
 * WebRTC makeCall.
 */
export function AgendaTodayList() {
  const { agenda, isLoading } = useMyAgendaToday(10);
  const { makeCall } = useWebRTCCallContext();

  // Hydrate phones em batch das profiles
  const { data: phoneMap } = useQuery({
    queryKey: ['agenda-phones', agenda.map((a) => a.customer_user_id).join(',')],
    enabled: agenda.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, { name: string; phone: string | null }>> => {
       
      const { data } = await supabase.from('profiles')
        .select('user_id, name, razao_social, phone')
        .in('user_id', agenda.map((a) => a.customer_user_id));
      const map: Record<string, { name: string; phone: string | null }> = {};
      for (const p of (data ?? []) as Array<{ user_id: string; name: string | null; razao_social: string | null; phone: string | null }>) {
        map[p.user_id] = { name: p.razao_social || p.name || 'Cliente', phone: p.phone };
      }
      return map;
    },
  });

  if (isLoading) {
    return (
      <Card className="p-6 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }

  if (agenda.length === 0) {
    return (
      <Card className="p-6 text-center text-xs text-muted-foreground">
        Sem clientes na agenda. Vá em <span className="font-mono">/farmer</span> antigo e clique &quot;Recalcular&quot; pra popular farmer_client_scores.
      </Card>
    );
  }

  const handleCall = async (phone: string | null) => {
    if (!phone) {
      toast.error('Cliente sem telefone cadastrado');
      return;
    }
    try {
      await makeCall(phone);
    } catch (err) {
      toast.error('Erro ao discar', { description: err instanceof Error ? err.message : '' });
    }
  };

  return (
    <Card className="divide-y divide-border">
      {agenda.map((item) => {
        const meta = AGENDA_META[item.agenda_type];
        const Icon = meta.icon;
        const info = phoneMap?.[item.customer_user_id];
        return (
          <div key={item.customer_user_id} className="p-3 flex items-center gap-3 hover:bg-muted/30">
            <Icon className={`w-4 h-4 ${meta.color} shrink-0`} />
            <Link to={`/admin/customers/${item.customer_user_id}`} className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{info?.name ?? '…'}</div>
              <div className="text-2xs text-muted-foreground flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-2xs">{meta.label}</Badge>
                {item.health_class && <span>health: {item.health_class}</span>}
                <span>priority: {Math.round(item.priority_score)}</span>
                {item.topModifier && (
                  <SignalModifierBadge modifier={item.topModifier} totalSignals={item.signalsCount} />
                )}
              </div>
            </Link>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 shrink-0"
              onClick={() => handleCall(info?.phone ?? null)}
              disabled={!info?.phone}
            >
              <Phone className="w-3.5 h-3.5" />
              Ligar
            </Button>
          </div>
        );
      })}
    </Card>
  );
}
