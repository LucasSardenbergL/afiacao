export type VisitaStatusDerivado = 'realizada' | 'cancelada' | 'atrasada' | 'hoje' | 'futura';

/**
 * Deriva o estado de exibição de uma visita agendada. 'atrasada' NÃO é coluna no
 * banco — é pendente com scheduled_date < hoje. Datas em ISO 'YYYY-MM-DD' (comparação
 * lexicográfica = cronológica nesse formato).
 */
export function deriveVisitaStatus(
  scheduledDate: string,
  status: string,
  today: string,
): VisitaStatusDerivado {
  if (status === 'realizada') return 'realizada';
  if (status === 'cancelada') return 'cancelada';
  if (scheduledDate < today) return 'atrasada';
  if (scheduledDate === today) return 'hoje';
  return 'futura';
}
