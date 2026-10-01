import { hojeSP } from '@/lib/time/sp-day';

/**
 * Data de hoje em ISO 'YYYY-MM-DD' — o dia de SÃO PAULO, o mesmo do DEFAULT de `route_visits.visit_date`
 * (20261001043717). Era o dia UTC (`toISOString`): das 21h BRT em diante, a agenda nascia com amanhã.
 */
export function hojeISO(): string {
  return hojeSP();
}
