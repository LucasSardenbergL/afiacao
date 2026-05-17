/**
 * Formatadores compactos pra KPIs do cockpit.
 * Ficam aqui (e não em `delta-aggregators`) pra ser reusados em qualquer zona
 * sem acoplar com a lógica de "desde a última visita".
 */

/**
 * Formata contagens inteiras com pt-BR thousand separator + sufixo compacto.
 *
 * - `< 1_000`        → "847"
 * - `< 10_000`       → "5.273"   (mantém precisão pra 4 dígitos)
 * - `< 1_000_000`    → "481k"
 * - `>= 1_000_000`   → "1,2M"
 *
 * Mantém legibilidade em KPI cell estreita (~120px @ text-xl).
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1_000) return String(Math.round(n));
  if (abs < 10_000) return n.toLocaleString('pt-BR');
  if (abs < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M`;
}

/**
 * Labels curtas pros status de `tint_importacoes.status` que aparecem no KPI
 * "Última import." — o texto cru ("processado", "processando") estoura o cell
 * e vira "processa..." truncado feio.
 */
export function formatImportStatus(status: string | null | undefined): string {
  if (!status) return '—';
  switch (status) {
    case 'concluido':
    case 'processado':
      return 'ok';
    case 'processando':
      return 'em curso';
    case 'erro':
      return 'erro';
    case 'parcial':
      return 'parcial';
    default:
      return status.length > 10 ? `${status.slice(0, 9)}…` : status;
  }
}
