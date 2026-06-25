import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Eye } from 'lucide-react';
import { CallButton } from '@/components/call/CallButton';
import { healthBadge, type CardCarteiraVM } from '@/lib/carteira/board';

export function CardCarteira({ card }: { card: CardCarteiraVM }) {
  const navigate = useNavigate();
  const hb = healthBadge(card.healthClass);
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium truncate">{card.nome}</span>
        <span className={`text-xs ${hb.className}`}>{hb.label}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {card.churnRisk != null && <span>Churn {Math.round(card.churnRisk)}%</span>}
        {card.slaVencido && (
          <Badge variant="outline" className="text-status-error border-status-error/30">
            SLA vencido{card.diasSemContato != null ? ` (${card.diasSemContato}d)` : ''}
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        {card.phone && <CallButton phone={card.phone} customerName={card.nome} variant="icon" />}
        <Button
          size="sm"
          variant="outline"
          onClick={() => navigate(`/admin/customers/${card.customer_user_id}/360`)}
        >
          <Eye className="w-3.5 h-3.5 mr-1" /> 360
        </Button>
      </div>
    </div>
  );
}
