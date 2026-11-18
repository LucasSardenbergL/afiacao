import { CalendarClock } from 'lucide-react';
import { rotuloRecebeEm } from '@/lib/reposicao/calendario/grade';
import type { PedidoSugerido } from './types';

/**
 * "recebe em DD/MM" — só quando o calendário de operação EMPURROU a chegada
 * (`recebimento_ajustado_calendario === true`). Em qualquer outro caso não renderiza nada.
 */
export function RecebeEmCalendario({ pedido }: { pedido: Pick<PedidoSugerido, 'recebimento_ajustado_calendario' | 'data_recebimento_prevista'> }) {
  const rotulo = rotuloRecebeEm(pedido);
  if (!rotulo) return null;
  return (
    <div
      className="mt-0.5 inline-flex items-center gap-1 text-xs text-status-warning"
      data-testid="recebe-em-calendario"
      title="Data de recebimento ajustada pelo calendário de operação (recesso ou dia fechado)"
    >
      <CalendarClock className="h-3 w-3" />
      {rotulo}
    </div>
  );
}
