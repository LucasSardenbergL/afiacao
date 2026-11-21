const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

const INDISPONIVEL = 'indisponível';

/** Centavos inteiros → "R$ 1.234,56". `null`/ausente → "indisponível" (NUNCA R$ 0,00). */
export function formatarCentavos(c: number | null | undefined): string {
  if (c === null || c === undefined || !Number.isFinite(c)) return INDISPONIVEL;
  return BRL.format(c / 100);
}

/** 'YYYY-MM-DD' → 'DD/MM/AAAA' sem passar por Date (sem fuso). */
export function formatarDataIso(d: string): string {
  const [a, m, dia] = d.split('-');
  return a && m && dia ? `${dia}/${m}/${a}` : d;
}

export interface DiaComSaldos {
  data: string;
  coberto: boolean;
  saldoFinal: number | null;
  saldoOmie: number | null;
}

export interface DiferencaDoCorte {
  /** Data de corte: último dia da janela com saldo do Itaú conhecido (fim do dia); `null` se não houver nenhum. */
  dataCorte: string | null;
  saldoItau: number | null;
  saldoOmie: number | null;
  /** saldo Itaú − saldo Omie; `null` (→ "indisponível") se faltar qualquer um dos dois, nunca 0. */
  diferenca: number | null;
}

/** Diferença do corte: usa o ÚLTIMO dia coberto com saldo Itaú conhecido. Ausente ≠ zero. */
export function diferencaDoCorte(dias: DiaComSaldos[]): DiferencaDoCorte {
  let corte: DiaComSaldos | null = null;
  for (const d of dias) {
    if (d.coberto && d.saldoFinal !== null && (corte === null || d.data > corte.data)) corte = d;
  }
  if (corte === null) return { dataCorte: null, saldoItau: null, saldoOmie: null, diferenca: null };
  const itau = corte.saldoFinal;
  const omie = corte.saldoOmie;
  return { dataCorte: corte.data, saldoItau: itau, saldoOmie: omie, diferenca: itau !== null && omie !== null ? itau - omie : null };
}

/** Primeiro e último dia do mês 'YYYY-MM' (aritmética em UTC, sem fuso). */
export function limitesDoMes(mes: string): { de: string; ate: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(mes);
  if (!m) return null;
  const ano = Number(m[1]);
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) return null;
  const ultimo = new Date(Date.UTC(ano, mm, 0)).getUTCDate();
  return { de: `${m[1]}-${m[2]}-01`, ate: `${m[1]}-${m[2]}-${String(ultimo).padStart(2, '0')}` };
}
