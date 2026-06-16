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

/**
 * Janela [de, ate) do MESMO PERÍODO do mês anterior, pra comparação MoM justa:
 * do dia 1 do mês passado até o mesmo dia-do-mês de hoje (capado no tamanho do mês anterior).
 * Ex.: hoje 04/06 → [01/05, 05/05) (= 1–4 de maio). hoje 31/03 → [01/02, 01/03) (fev tem 28). Puro.
 */
export function periodoMesAnterior(hoje: string): { de: string; ate: string } {
  const y = parseInt(hoje.slice(0, 4), 10);
  const m = parseInt(hoje.slice(5, 7), 10); // 1-12
  const d = parseInt(hoje.slice(8, 10), 10);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prevMM = String(prevM).padStart(2, '0');
  const prevLast = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate(); // último dia do mês anterior
  const endDay = Math.min(d, prevLast);
  const de = `${prevY}-${prevMM}-01`;
  const ate = addDias(`${prevY}-${prevMM}-${String(endDay).padStart(2, '0')}`, 1);
  return { de, ate };
}
