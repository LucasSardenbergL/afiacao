/** Data de hoje em ISO 'YYYY-MM-DD' (UTC, consistente com a convenção do route planner). */
export function hojeISO(): string {
  return new Date().toISOString().split('T')[0];
}
