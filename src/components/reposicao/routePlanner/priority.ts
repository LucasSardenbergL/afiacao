// Scoring de prioridade das paradas de rota.
// Extraído de src/pages/AdminRoutePlanner.tsx (god-component split).
import type { RouteStop } from './types';

function computeStopPriority(
  stop: Omit<RouteStop, 'priorityScore' | 'priorityLabel' | 'priorityFactors'>,
): Pick<RouteStop, 'priorityScore' | 'priorityLabel' | 'priorityFactors'> {
  let score = 0;
  const factors: string[] = [];

  // Logistic urgency
  if (stop.stopType === 'pickup_tools') {
    score += 40; factors.push('+40 coleta pendente');
  } else if (stop.stopType === 'deliver_tools') {
    score += 35; factors.push('+35 entrega pronta');
  }

  // Overdue tools
  if (stop.visitReason.includes('afiação vencida')) {
    score += 25; factors.push('+25 ferramenta vencida');
  }

  // Commercial opportunity from agenda
  if (stop.visitReason.includes('Risco')) {
    score += 20; factors.push('+20 risco de churn');
  } else if (stop.visitReason.includes('Expansão')) {
    score += 15; factors.push('+15 expansão cross-sell');
  } else if (stop.visitReason.includes('Follow-up')) {
    score += 10; factors.push('+10 follow-up');
  }

  // Hybrid gets a bonus (multiple reasons to visit)
  if (stop.stopType === 'hybrid_visit') {
    score += 15; factors.push('+15 visita híbrida');
  }

  // Higher-value orders
  if (stop.total && stop.total > 200) {
    score += 10; factors.push('+10 pedido alto valor');
  }

  const label: RouteStop['priorityLabel'] =
    score > 50 ? 'alta' : score >= 25 ? 'media' : 'baixa';
  return { priorityScore: score, priorityLabel: label, priorityFactors: factors };
}

export function enrichWithPriority(
  stop: Omit<RouteStop, 'priorityScore' | 'priorityLabel' | 'priorityFactors'>,
): RouteStop {
  return { ...stop, ...computeStopPriority(stop) } as RouteStop;
}
