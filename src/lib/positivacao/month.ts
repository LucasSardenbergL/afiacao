/** Fronteira do mês comercial corrente (MTD) no fuso America/Sao_Paulo, como datas ISO yyyy-mm-dd. */
export function mesComercialCorrente(now: Date = new Date()): { inicioIso: string; fimIso: string } {
  // Converte 'now' pra data-local de São Paulo via Intl (robusto a DST/offset).
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value); // 1-12

  const inicio = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const fim = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
  return { inicioIso: inicio, fimIso: fim };
}
