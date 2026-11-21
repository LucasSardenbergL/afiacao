import { decimalTextoParaCentavos } from './nucleo';

/**
 * Entrada do formulário "saldo de referência (manual)" -> centavos INTEIROS com sinal.
 * Ausente/ambíguo -> `null` (erro de validação), NUNCA 0: "12.345" (milhar ou decimal?) é recusado.
 * Aceita sinal à parte ("-1.234,56"). Aritmética de string/inteiro (decimalTextoParaCentavos), nunca parseFloat.
 */
export function saldoBrParaCentavos(texto: string): number | null {
  const t = texto.trim();
  if (t === '') return null;
  const negativo = t.startsWith('-');
  const abs = decimalTextoParaCentavos(t);
  if (abs === null) return null;
  return negativo && abs !== 0 ? -abs : abs;
}

/** 'YYYY-MM-DD' de hoje em America/Sao_Paulo (o dia "aberto" que a RPC recusa como âncora). */
export function hojeSaoPaulo(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
}

export interface EntradaAncora {
  data: string;
  saldo: string;
}

export type ValidacaoAncora =
  | { ok: true; data: string; centavos: number }
  | { ok: false; erros: { data?: string; saldo?: string } };

function dataIsoValida(d: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return false;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return dt.getUTCFullYear() === Number(m[1]) && dt.getUTCMonth() === Number(m[2]) - 1 && dt.getUTCDate() === Number(m[3]);
}

/** Valida data (dia já fechado: < hoje em SP) e saldo (formato BR inequívoco). Nada é chamado se `ok=false`. */
export function validarAncora(e: EntradaAncora, hoje: string): ValidacaoAncora {
  const erros: { data?: string; saldo?: string } = {};
  if (!dataIsoValida(e.data)) erros.data = 'Informe uma data válida.';
  else if (e.data >= hoje) erros.data = 'Use um dia já fechado (até ontem).';
  const centavos = saldoBrParaCentavos(e.saldo);
  if (centavos === null) {
    erros.saldo = 'Informe o saldo no formato 12.345,67 (vírgula nos centavos; pode ser negativo).';
  }
  if (erros.data || erros.saldo || centavos === null) return { ok: false, erros };
  return { ok: true, data: e.data, centavos };
}
