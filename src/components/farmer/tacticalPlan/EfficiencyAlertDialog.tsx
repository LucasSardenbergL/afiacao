// Dialog de alerta de potencial baixo (lucro/hora abaixo do limiar).
// Extraído verbatim de src/pages/FarmerTacticalPlan.tsx (god-component split).
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { PlanType } from '@/hooks/useTacticalPlan';
import { fmt } from './config';

interface EfficiencyAlertDialogProps {
  /** `profitPerHour: null` ⇒ R$/h não estimável; `motivo` diz se foi ausência de dado do
   *  cliente (`sem_margem`) ou falha da nossa consulta (`indisponivel`). */
  alert: { customerId: string; profitPerHour: number | null; motivo?: 'sem_margem' | 'indisponivel'; planType: PlanType } | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function EfficiencyAlertDialog({ alert, onClose, onConfirm }: EfficiencyAlertDialogProps) {
  return (
    <Dialog open={!!alert} onOpenChange={onClose}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-status-warning" />
            {alert?.profitPerHour == null ? 'Potencial não estimável' : 'Potencial Baixo'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {/* Três estados distintos. Margem desconhecida NÃO é "R$ 0,00/h" — dizer que o
              potencial é baixo quando não medimos acusa o cliente de um problema de dado.
              E falha de CONSULTA não é ausência de margem: afirmar "sem custo cadastrado"
              após um timeout alegaria um fato sobre o cliente a partir de um erro nosso. */}
          {alert?.motivo === 'indisponivel' ? (
            <p className="text-xs text-muted-foreground">
              Não foi possível <strong className="text-foreground">consultar os dados</strong> deste
              cliente agora, então o lucro por hora não pôde ser estimado. Isto não diz nada sobre o
              potencial dele — tente de novo em instantes.
            </p>
          ) : alert?.profitPerHour == null ? (
            <p className="text-xs text-muted-foreground">
              Não foi possível estimar o lucro por hora deste cliente: a{' '}
              <strong className="text-foreground">margem bruta é desconhecida</strong> (nenhum item
              comprado tem custo cadastrado).
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              O lucro estimado por hora para este cliente é de{' '}
              <strong className="text-foreground">{fmt(alert.profitPerHour)}/h</strong>,
              abaixo do limiar recomendado de <strong className="text-foreground">{fmt(50)}/h</strong>.
            </p>
          )}
          <p className="text-xs text-muted-foreground">Deseja continuar mesmo assim?</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1 text-xs" onClick={onClose}>
              Cancelar
            </Button>
            <Button size="sm" className="flex-1 text-xs" onClick={onConfirm}>
              Continuar
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
