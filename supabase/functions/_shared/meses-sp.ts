// Aritmética de MESES sobre o dia de negócio — separada de `hoje-sp.ts` de propósito: deployar uma edge sobe
// o fecho inteiro dos imports locais, e as edges que só precisam do dia não devem mudar de impressão digital
// (e pedir re-deploy) quando esta régua mudar. Testes em meses-sp_test.ts.

const DIA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Soma `n` meses a uma data `YYYY-MM-DD` com a MESMA semântica de `Date#setMonth`: o dia que não existe no
 * mês de destino TRANSBORDA para o seguinte (31/08 − 6 meses = 03/03). É a régua das janelas de busca que
 * este helper substitui (`setMonth(getMonth() - 6)` no servidor UTC) — mudar o transbordo mudaria as
 * janelas. Aritmética de calendário em UTC puro, sem relógio; o dia vem de quem chama (`hojeSP()`).
 * Data malformada LANÇA.
 */
export function somarMeses(dia: string, n: number): string {
  const m = DIA_ISO.exec(dia);
  if (!m || !Number.isInteger(n)) throw new RangeError(`somarMeses: data ou deslocamento inválido (${dia}, ${n})`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCMonth(d.getUTCMonth() + n);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}
