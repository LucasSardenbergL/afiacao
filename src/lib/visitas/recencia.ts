/** Dias de calendário entre a data de `iso` e `hojeISO` (ambos 'YYYY-MM-DD' ou ISO completo).
 *  null se `iso` vazio/inválido. Usa a parte de DATA (UTC) — consistente com a convenção do codebase. */
export function diasDesde(iso: string | null | undefined, hojeISO: string): number | null {
  if (!iso) return null;
  const d = iso.slice(0, 10);
  const h = hojeISO.slice(0, 10);
  const ms = Date.parse(`${h}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 86_400_000);
}

/** Rótulo de recência: nunca / hoje / ontem / há N dias. Data futura (n<0) → "hoje". */
export function recenciaLabel(iso: string | null | undefined, hojeISO: string): string {
  const n = diasDesde(iso, hojeISO);
  if (n === null) return 'nunca';
  if (n <= 0) return 'hoje';
  if (n === 1) return 'ontem';
  return `há ${n} dias`;
}
