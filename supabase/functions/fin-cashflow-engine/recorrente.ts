// Ocorrências de um evento recorrente mensal numa janela [de, ate] (dia do mês com clamp no fim do mês,
// respeitando inicio/fim). Extraído do index.ts na v2.7 para que a projeção semanal e a reserva de folha
// da NCG decidam "há ocorrência?" pela MESMA regra (achado Codex: a NCG olhava só a vigência).
export type RecorrenteVigencia = { dia_do_mes: number; inicio: string; fim: string | null };

export function expandirRecorrenteDeno(
  rec: RecorrenteVigencia,
  de: string,
  ate: string,
): string[] {
  const result: string[] = [];
  const startBase = rec.inicio > de ? rec.inicio : de;
  const start = new Date(startBase + 'T00:00:00Z');
  const end = new Date(ate + 'T00:00:00Z');
  const fim = rec.fim ? new Date(rec.fim + 'T00:00:00Z') : null;

  let ano = start.getUTCFullYear();
  let mes1 = start.getUTCMonth() + 1;
  while (true) {
    const ultimoDia = new Date(Date.UTC(ano, mes1, 0)).getUTCDate();
    const dia = Math.min(rec.dia_do_mes, ultimoDia);
    const candidato = new Date(Date.UTC(ano, mes1 - 1, dia));
    if (candidato > end) break;
    if (candidato >= start && (!fim || candidato <= fim)) {
      result.push(candidato.toISOString().slice(0, 10));
    }
    mes1++;
    if (mes1 > 12) { mes1 = 1; ano++; }
  }
  return result;
}
