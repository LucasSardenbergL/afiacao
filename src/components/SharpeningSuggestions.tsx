import { useNavigate } from 'react-router-dom';
import { Bell, Calendar, ChevronRight, AlertTriangle, Clock, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSharpeningSuggestions, SharpeningTool } from '@/hooks/useSharpenningSuggestions';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';

interface SharpeningSuggestionsProps {
  compact?: boolean;
}

export function SharpeningSuggestions({ compact = false }: SharpeningSuggestionsProps) {
  const navigate = useNavigate();
  const { overdueTools, dueSoonTools, upcomingTools, loading } = useSharpeningSuggestions();

  if (loading) {
    return (
      <div className="bg-card rounded-xl p-4 border border-border animate-pulse">
        <div className="h-4 bg-muted rounded w-1/2 mb-2" />
        <div className="h-3 bg-muted rounded w-3/4" />
      </div>
    );
  }

  const hasOverdue = overdueTools.length > 0;
  const hasDueSoon = dueSoonTools.length > 0;
  const hasAny = hasOverdue || hasDueSoon || upcomingTools.length > 0;

  if (!hasAny) return null;

  // Compact version for home page
  if (compact) {
    if (hasOverdue) {
      return (
        <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-destructive/20 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-5 h-5 text-destructive" />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-destructive">
                {overdueTools.length} ferramenta(s) com afiação atrasada
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {overdueTools.slice(0, 2).map(t => t.categoryName).join(', ')}
                {overdueTools.length > 2 && ` e mais ${overdueTools.length - 2}`}
              </p>
              <Button 
                size="sm" 
                variant="destructive"
                className="mt-3"
                onClick={() => navigate('/new-order')}
              >
                Agendar Agora
              </Button>
            </div>
          </div>
        </div>
      );
    }

    if (hasDueSoon) {
      return (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
              <Bell className="w-5 h-5 text-amber-600" />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-amber-900">
                {dueSoonTools.length} ferramenta(s) precisam de afiação em breve
              </p>
              <p className="text-sm text-amber-700 mt-1">
                {dueSoonTools.slice(0, 2).map(t => t.categoryName).join(', ')}
                {dueSoonTools.length > 2 && ` e mais ${dueSoonTools.length - 2}`}
              </p>
              <Button 
                size="sm" 
                className="mt-3"
                onClick={() => navigate('/new-order')}
              >
                Agendar Afiação
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return null;
  }

  // Full version for profile/tools page
  return (
    <div className="space-y-4">
      {/* Overdue Tools */}
      {hasOverdue && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-xl p-4">
          <h3 className="font-semibold text-destructive flex items-center gap-2 mb-3">
            <AlertTriangle className="w-4 h-4" />
            Afiação Atrasada
          </h3>
          <div className="space-y-2">
            {overdueTools.map(tool => (
              <ToolCard key={tool.id} tool={tool} variant="overdue" />
            ))}
          </div>
          <Button 
            className="w-full mt-3"
            variant="destructive"
            onClick={() => navigate('/new-order')}
          >
            Agendar Afiação Agora
          </Button>
        </div>
      )}

      {/* Due Soon Tools */}
      {hasDueSoon && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <h3 className="font-semibold text-amber-900 flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4" />
            Afiação em Breve
          </h3>
          <div className="space-y-2">
            {dueSoonTools.map(tool => (
              <ToolCard key={tool.id} tool={tool} variant="soon" />
            ))}
          </div>
          <Button 
            className="w-full mt-3"
            onClick={() => navigate('/new-order')}
          >
            Agendar Afiação
          </Button>
        </div>
      )}

      {/* Upcoming Tools */}
      {upcomingTools.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-4">
          <h3 className="font-semibold text-foreground flex items-center gap-2 mb-3">
            <Calendar className="w-4 h-4" />
            Próximas Afiações
          </h3>
          <div className="space-y-2">
            {upcomingTools.slice(0, 5).map(tool => (
              <ToolCard key={tool.id} tool={tool} variant="upcoming" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface ToolCardProps {
  tool: SharpeningTool;
  variant: 'overdue' | 'soon' | 'upcoming';
}

function ToolCard({ tool, variant }: ToolCardProps) {
  const getDaysText = () => {
    if (tool.isOverdue) {
      const daysOverdue = Math.abs(tool.daysUntilDue);
      return `${daysOverdue} dia${daysOverdue !== 1 ? 's' : ''} atrasado`;
    }
    if (tool.daysUntilDue === 0) {
      return 'Hoje';
    }
    if (tool.daysUntilDue === 1) {
      return 'Amanhã';
    }
    return `em ${tool.daysUntilDue} dias`;
  };

  return (
    <div className={cn(
      'flex items-center gap-3 p-3 rounded-lg',
      variant === 'overdue' && 'bg-destructive/5',
      variant === 'soon' && 'bg-amber-100/50',
      variant === 'upcoming' && 'bg-muted/50'
    )}>
      <div className={cn(
        'w-8 h-8 rounded-full flex items-center justify-center',
        variant === 'overdue' && 'bg-destructive/20',
        variant === 'soon' && 'bg-amber-200',
        variant === 'upcoming' && 'bg-muted'
      )}>
        <Wrench className={cn(
          'w-4 h-4',
          variant === 'overdue' && 'text-destructive',
          variant === 'soon' && 'text-amber-700',
          variant === 'upcoming' && 'text-muted-foreground'
        )} />
      </div>
      <div className="flex-1">
        <p className={cn(
          'font-medium text-sm',
          variant === 'overdue' && 'text-destructive',
          variant === 'soon' && 'text-amber-900',
          variant === 'upcoming' && 'text-foreground'
        )}>
          {tool.categoryName}
        </p>
        <p className={cn(
          'text-xs',
          variant === 'overdue' && 'text-destructive/70',
          variant === 'soon' && 'text-amber-700',
          variant === 'upcoming' && 'text-muted-foreground'
        )}>
          {getDaysText()}
          {tool.lastSharpenedAt && (
            <> • Última: {format(tool.lastSharpenedAt, "dd/MM/yy")}</>
          )}
        </p>
      </div>
      {tool.nextSharpeningDue && (
        <span className={cn(
          'text-xs font-medium px-2 py-1 rounded-full',
          variant === 'overdue' && 'bg-destructive/20 text-destructive',
          variant === 'soon' && 'bg-amber-200 text-amber-800',
          variant === 'upcoming' && 'bg-muted text-muted-foreground'
        )}>
          {format(tool.nextSharpeningDue, "dd/MM")}
        </span>
      )}
    </div>
  );
}
