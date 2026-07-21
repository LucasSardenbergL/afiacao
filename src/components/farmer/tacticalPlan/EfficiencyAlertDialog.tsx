// Dialog de alerta de potencial baixo (lucro/hora abaixo do limiar).
// Extraído verbatim de src/pages/FarmerTacticalPlan.tsx (god-component split).
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { PlanType } from '@/hooks/useTacticalPlan';
import { fmt } from './config';

interface EfficiencyAlertDialogProps {
  /** `profitPerHour: null` = margem não apurada → o R$/h é INDECIDÍVEL, não baixo. */
  alert: { customerId: string; profitPerHour: number | null; planType: PlanType } | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function EfficiencyAlertDialog({ alert, onClose, onConfirm }: EfficiencyAlertDialogProps) {
  // Dois motivos distintos para o alerta e a vendedora precisa saber qual é: "este cliente rende
  // pouco" é um veredito acionável; "não consegui calcular" é ausência de dado. Antes o `|| 0`
  // exibia "R$ 0,00/h abaixo do limiar" nos dois casos — uma afirmação falsa no segundo.
  const indecidivel = alert != null && alert.profitPerHour == null;
  return (
    <Dialog open={!!alert} onOpenChange={onClose}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-status-warning" />
            {indecidivel ? 'Potencial não estimado' : 'Potencial Baixo'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {indecidivel ? (
            <p className="text-xs text-muted-foreground">
              Não foi possível estimar o lucro por hora deste cliente: a{' '}
              <strong className="text-foreground">margem ainda não foi apurada</strong> (nenhum item
              comprado tem custo conhecido). O limiar de referência é{' '}
              <strong className="text-foreground">{fmt(50)}/h</strong>.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              O lucro estimado por hora para este cliente é de{' '}
              <strong className="text-foreground">{fmt(alert?.profitPerHour ?? 0)}/h</strong>,
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
