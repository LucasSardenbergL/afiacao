import { useCustomerCalls } from '@/hooks/useCustomerCalls';
import { aggregateCustomerProfile } from '@/lib/call-session/aggregate-customer-profile';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Phone, TrendingUp, Wallet, Clock, AlertTriangle, Building2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export function CustomerProfile360Summary({ customerId }: { customerId: string }) {
  const { data } = useCustomerCalls(customerId);
  const profile = aggregateCustomerProfile(data ?? []);

  if (profile.totalCalls === 0) return null;

  return (
    <Card className="p-3 space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI icon={Phone} label="Chamadas" value={profile.totalCalls.toString()} sub={profile.lastCallAt ? `Última ${formatDistanceToNow(new Date(profile.lastCallAt), { locale: ptBR, addSuffix: true })}` : ''} />
        <KPI icon={Clock} label="Duração total" value={`${Math.floor(profile.totalDurationSeconds / 60)}min`} />
        <KPI icon={Wallet} label="Receita acumulada" value={`R$ ${profile.totalRevenue.toLocaleString('pt-BR')}`} sub={profile.totalMargin > 0 ? `Margem R$ ${profile.totalMargin.toLocaleString('pt-BR')}` : ''} />
        <KPI icon={TrendingUp} label="Ticket médio" value={profile.avgTicket > 0 ? `R$ ${Math.round(profile.avgTicket).toLocaleString('pt-BR')}` : '—'} />
      </div>

      {profile.competitorsMentioned.length > 0 && (
        <div className="space-y-1">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Building2 className="w-3 h-3"/>Concorrentes citados pelo cliente
          </div>
          <div className="flex flex-wrap gap-1.5">
            {profile.competitorsMentioned.map(c => (
              <Badge key={c.value} variant="outline" className="text-2xs">
                {c.value} <span className="ml-1 opacity-60">×{c.totalOccurrences}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}

      {profile.topObjections.length > 0 && (
        <div className="space-y-1">
          <div className="text-2xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <AlertTriangle className="w-3 h-3"/>Objeções recorrentes
          </div>
          <div className="flex flex-wrap gap-1.5">
            {profile.topObjections.map(o => (
              <Badge key={o.type} variant="outline" className="text-2xs" title={o.exampleNote}>
                {o.type.replace(/_/g, ' ')} <span className="ml-1 opacity-60">×{o.count}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function KPI({ icon: Icon, label, value, sub }: { icon: typeof Phone; label: string; value: string; sub?: string }) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
        <Icon className="w-3 h-3" />{label}
      </div>
      <div className="text-base font-medium tabular-nums">{value}</div>
      {sub && <div className="text-2xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
