import { useCompany } from '@/contexts/CompanyContext';
import { useCashflowAlertas, useDismissAlerta, type Alerta } from '@/hooks/useCashflowAlertas';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, AlertOctagon, Info, X, Clock } from 'lucide-react';
import { toast } from 'sonner';

const SEVERIDADE_ICON: Record<Alerta['severidade'], typeof Info> = {
  info: Info,
  aviso: AlertTriangle,
  critico: AlertOctagon,
};

const SEVERIDADE_STYLE: Record<Alerta['severidade'], string> = {
  info: 'border-status-info bg-status-info-bg',
  aviso: 'border-status-warning bg-status-warning-bg',
  critico: 'border-status-error bg-status-error-bg',
};

export function AlertasStack() {
  const { activeCompany } = useCompany();
  const { data, isLoading } = useCashflowAlertas(activeCompany);
  const dismiss = useDismissAlerta();

  if (isLoading || !data || data.length === 0) return null;

  const handleDismiss = async (id: string, days?: number) => {
    try {
      await dismiss.mutateAsync({ id, snoozeDays: days });
      toast.success(days ? `Alerta silenciado por ${days} dias` : 'Alerta dispensado');
    } catch (err) {
      toast.error('Falha: ' + String((err as Error).message ?? err));
    }
  };

  return (
    <div className="space-y-2">
      {data.map(a => {
        const Icon = SEVERIDADE_ICON[a.severidade];
        return (
          <Alert key={a.id} className={SEVERIDADE_STYLE[a.severidade]}>
            <Icon className="h-4 w-4" />
            <AlertTitle className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">{a.tipo}</Badge>
            </AlertTitle>
            <AlertDescription className="flex items-start justify-between gap-3">
              <span>{a.mensagem}</span>
              <div className="flex gap-1 shrink-0">
                <Button size="sm" variant="ghost" onClick={() => handleDismiss(a.id, 7)} title="Silenciar 7 dias">
                  <Clock className="h-3 w-3" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => handleDismiss(a.id)} title="Dispensar permanente">
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        );
      })}
    </div>
  );
}
