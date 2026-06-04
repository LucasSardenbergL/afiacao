/**
 * Datas de negócio no fuso America/Sao_Paulo (SP = UTC−3 fixo desde 2019, sem horário de verão).
 * Usado por métricas de "hoje/mês" onde UTC vazaria o dia à noite. Helpers puros (input-driven)
 * testáveis; só `hojeSP` depende do relógio.
 */

/** Data de hoje em SP, 'YYYY-MM-DD'. */
export function hojeSP(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

/** Soma `n` dias (pode ser negativo) a uma data 'YYYY-MM-DD'. Puro. */
export function addDias(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Primeiro dia do mês de `iso` ('YYYY-MM-01'). Puro. */
export function inicioMes(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/** Instante UTC da meia-noite de SP do dia `iso` (UTC−3 → T03:00:00Z). Puro. */
export function spMeiaNoiteUTC(iso: string): string {
  return `${iso.slice(0, 10)}T03:00:00.000Z`;
}
