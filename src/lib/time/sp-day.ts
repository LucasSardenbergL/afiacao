/**
 * Janela [início, fim) do DIA corrente no fuso America/Sao_Paulo, como instantes UTC (ISO).
 *
 * Use com colunas `timestamptz`:
 *   `.gte('started_at', startUtc).lt('started_at', endUtc)`
 *
 * Por que não usar `new Date().toISOString().slice(0,10)` direto:
 *  - `toISOString()` é UTC → no Brasil (UTC-3), das ~21h às 24h locais a data UTC já virou o
 *    DIA SEGUINTE → uma query `.gte(dataUTC)` perde TODAS as linhas do dia local (KPIs zeram à noite).
 *  - mesmo a data certa como STRING (yyyy-mm-dd) com `.gte` numa `timestamptz` compara contra
 *    meia-noite UTC, não meia-noite de São Paulo → janela deslocada 3h.
 * A solução é resolver o dia EM SP e materializar as fronteiras como instantes UTC.
 */
export function spDayRangeUtc(now: Date = new Date()): { startUtc: string; endUtc: string } {
  // (1) Qual é o dia corrente EM São Paulo (robusto à virada de data UTC).
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y, m, d] = fmt.format(now).split('-').map(Number); // 'yyyy-mm-dd'

  // (2) Offset de SP neste instante, em ms (robusto a DST: compara wall-clock SP × UTC).
  const offsetMs = spOffsetMs(now);

  // (3) Meia-noite local de SP → instante UTC = (meia-noite como-se-UTC) − offset.
  const startMs = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMs;
  const endMs = startMs + 24 * 60 * 60 * 1000; // Brasil sem horário de verão desde 2019 → dia = 24h.

  return { startUtc: new Date(startMs).toISOString(), endUtc: new Date(endMs).toISOString() };
}

const SP_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
});
/** Data de NEGÓCIO (yyyy-mm-dd) de um instante, no fuso America/Sao_Paulo. */
export function spBusinessDate(instant: Date | string): string {
  return SP_DATE_FMT.format(typeof instant === 'string' ? new Date(instant) : instant);
}

/** Offset de America/Sao_Paulo em `date`, em ms (SP − UTC; negativo p/ UTC-3). */
function spOffsetMs(date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour; // alguns runtimes emitem '24' p/ meia-noite
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  return asUtc - date.getTime();
}
