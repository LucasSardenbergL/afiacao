// Card de ação recomendada (prioridade) do CustomerDashboard.
// Extraído verbatim de src/components/CustomerDashboard.tsx (god-component split).
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PriorityAction } from './types';

export function PriorityCard({ priority, navigate }: { priority: PriorityAction; navigate: ReturnType<typeof useNavigate> }) {
  const bgMap: Record<PriorityAction['variant'], string> = {
    warning: 'border-status-warning/30 bg-status-warning-bg/60',
    destructive: 'border-destructive/30 bg-destructive/5',
    default: 'border-border bg-card',
    success: 'border-primary/20 bg-primary/5',
  };
  const iconBgMap: Record<PriorityAction['variant'], string> = {
    warning: 'bg-status-warning-bg text-status-warning',
    destructive: 'bg-destructive/10 text-destructive',
    default: 'bg-muted text-muted-foreground',
    success: 'bg-primary/10 text-primary',
  };

  return (
    <Card className={cn('shadow-medium overflow-hidden', bgMap[priority.variant])}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0', iconBgMap[priority.variant])}>
            <priority.icon className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-sm text-foreground mb-0.5">{priority.title}</h3>
            <p className="text-xs text-muted-foreground">{priority.description}</p>
          </div>
        </div>
        {priority.buttonLabel && priority.path && (
          <Button
            size="sm"
            className="w-full rounded-xl mt-3"
            variant={priority.variant === 'success' ? 'outline' : 'default'}
            onClick={() => navigate(priority.path!)}
          >
            {priority.buttonLabel}
            <ArrowRight className="w-4 h-4 ml-1.5" />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
