import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Phone, DollarSign, TrendingUp, Link2, Loader2 } from 'lucide-react';
import { useMyKpis } from '@/hooks/useMyKpis';

export function KpisToday() {
  const { data: k, isLoading } = useMyKpis();
  if (isLoading || !k) {
    return (
      <Card className="p-4 flex justify-center">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <Kpi icon={Phone} label="Chamadas hoje" value={String(k.calls_today)} />
      <Kpi icon={DollarSign} label="Receita hoje" value={`R$ ${k.revenue_today.toLocaleString('pt-BR')}`} />
      <Kpi
        icon={TrendingUp}
        label="Ticket médio"
        value={k.avg_ticket_today > 0 ? `R$ ${Math.round(k.avg_ticket_today).toLocaleString('pt-BR')}` : '—'}
      />
      <Link to="/farmer/calls/pending-link">
        <Kpi icon={Link2} label="Pendentes" value={String(k.pending_link_count)} clickable />
      </Link>
    </div>
  );
}

function Kpi({
  icon: Icon,
  label,
  value,
  clickable,
}: {
  icon: typeof Phone;
  label: string;
  value: string;
  clickable?: boolean;
}) {
  return (
    <Card className={`p-3 space-y-1 ${clickable ? 'hover:bg-muted/40 cursor-pointer transition-colors' : ''}`}>
      <div className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <div className="text-base font-medium tabular-nums">{value}</div>
    </Card>
  );
}
