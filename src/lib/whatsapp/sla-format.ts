export type SlaNivel = 'verde' | 'amarelo' | 'vermelho';

/** Minutos → "18 min" / "1h" / "1h05". <=0 ou inválido → "0 min". */
export function formatSlaWait(minutos: number): string {
  if (!Number.isFinite(minutos) || minutos <= 0) return '0 min';
  const m = Math.floor(minutos);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h}h` : `${h}h${String(r).padStart(2, '0')}`;
}

/** Classes Tailwind de status por nível (tokens do design system; nunca text-emerald-*). */
export function slaNivelClasses(nivel: SlaNivel): string {
  switch (nivel) {
    case 'vermelho': return 'text-status-error bg-status-error-bg';
    case 'amarelo': return 'text-status-warning bg-status-warning-bg';
    default: return 'text-status-success bg-status-success-bg';
  }
}
