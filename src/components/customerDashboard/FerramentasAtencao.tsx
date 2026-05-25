// Seção "Ferramentas que Exigem Atenção" do CustomerDashboard.
// Extraída verbatim de src/components/CustomerDashboard.tsx (god-component split).
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Wrench, PlusCircle, ChevronRight } from 'lucide-react';
import { differenceInDays } from 'date-fns';
import { cn } from '@/lib/utils';
import type { UserTool } from './types';

interface FerramentasAtencaoProps {
  urgentTools: UserTool[];
  navigate: ReturnType<typeof useNavigate>;
}

export function FerramentasAtencao({ urgentTools, navigate }: FerramentasAtencaoProps) {
  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display font-bold text-lg text-foreground">Ferramentas com Atenção</h2>
        <button onClick={() => navigate('/tools')} className="text-sm font-medium text-primary flex items-center gap-1 hover:gap-2 transition-all">
          Gerenciar <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <Card className="border-status-warning/20 bg-status-warning-bg/50">
        <CardContent className="p-4 space-y-3">
          {urgentTools.slice(0, 4).map(tool => {
            const days = differenceInDays(new Date(tool.next_sharpening_due!), new Date());
            return (
              <div key={tool.id} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center',
                    days < 0 ? 'bg-destructive/10' : 'bg-status-warning-bg'
                  )}>
                    <Wrench className={cn('w-4 h-4', days < 0 ? 'text-destructive' : 'text-status-warning')} />
                  </div>
                  <span className="text-sm font-medium text-foreground">{tool.tool_categories?.name}</span>
                </div>
                <span className={cn(
                  'text-xs font-semibold px-2 py-0.5 rounded-full',
                  days < 0 ? 'bg-destructive/10 text-destructive' : 'bg-status-warning-bg text-status-warning-foreground'
                )}>
                  {days < 0 ? `${Math.abs(days)}d atrasado` : days === 0 ? 'Hoje' : `Em ${days}d`}
                </span>
              </div>
            );
          })}
          <Button size="sm" className="w-full rounded-xl mt-1" onClick={() => navigate('/new-order')}>
            <PlusCircle className="w-4 h-4 mr-1.5" />
            Criar pedido
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
