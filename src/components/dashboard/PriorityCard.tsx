import { useNavigate } from 'react-router-dom';
import { CheckCircle2, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import type { PriorityCandidate, PriorityVariant } from '@/lib/dashboard/priority-rules';

const VARIANT_STYLES: Record<PriorityVariant, { card: string; iconBg: string; iconColor: string }> = {
  critical: {
    card: 'border-status-error-bold/30 bg-status-error-bg/40',
    iconBg: 'bg-status-error-bg',
    iconColor: 'text-status-error-bold',
  },
  warning: {
    card: 'border-status-warning-bold/30 bg-status-warning-bg/40',
    iconBg: 'bg-status-warning-bg',
    iconColor: 'text-status-warning-bold',
  },
  info: {
    card: 'border-status-info-bold/30 bg-status-info-bg/40',
    iconBg: 'bg-status-info-bg',
    iconColor: 'text-status-info-bold',
  },
  success: {
    card: 'border-status-success-bold/30 bg-status-success-bg/40',
    iconBg: 'bg-status-success-bg',
    iconColor: 'text-status-success-bold',
  },
};

export function PriorityCard({ winner }: { winner: PriorityCandidate | null }) {
  const navigate = useNavigate();

  if (!winner) {
    return (
      <Card className="max-w-2xl mx-auto border-status-success-bold/20 bg-status-success-bg/30">
        <CardContent className="p-5 flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl bg-status-success-bg flex items-center justify-center shrink-0">
            <CheckCircle2 className="w-5 h-5 text-status-success-bold" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-display text-base font-medium text-foreground">Tudo sob controle</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Nada que peça sua atenção agora. Confira o cockpit abaixo pra ver o panorama.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const { item, score, zone } = winner;
  const styles = VARIANT_STYLES[item.variant];
  const Icon = item.icon;

  const handleClick = () => {
    track('dashboard.brief.priority_cta_clicked', { zone, score, item_id: item.id });
    navigate(item.cta.path);
  };

  return (
    <Card className={cn('max-w-2xl mx-auto', styles.card)}>
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0', styles.iconBg)}>
            <Icon className={cn('w-5 h-5', styles.iconColor)} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-display text-base font-medium text-foreground">{item.title}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
          </div>
          <Button size="touch" onClick={handleClick} className="shrink-0">
            {item.cta.label}
            <ArrowRight className="w-4 h-4 ml-1.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
