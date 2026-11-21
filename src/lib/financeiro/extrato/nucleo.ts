// Núcleo puro do extrato bancário: tipos, normalização, centavos, chave de dedupe e fechamento.
// NÃO importa nada: a cópia em supabase/functions/_shared/extrato-nucleo.ts é byte-idêntica
// (a edge roda sob `deno test --no-remote` e não pode importar de `src/`). Paridade provada em
// __tests__/nucleo.parity.test.ts. As chaves geradas aqui são gravadas em banco_extrato_linha.chave.

export type Sentido = 'C' | 'D';
export type FormatoExtrato = 'ofx' | 'cnab240';

export interface LinhaExtrato {
  data: string;
  sentido: Sentido;
  valorCentavos: number;
  descricao: string;
  documento: string | null;
  idBancario: string | null;
}

export interface ExtratoParseado {
  formato: FormatoExtrato;
  /** Código do banco (BANKID só dígitos, zeros à esquerda preservados); null quando o arquivo não traz. */
  banco: string | null;
  agencia: string | null;
  conta: string;
  periodoInicio: string;
  periodoFim: string;
  saldoInicialCentavos: number | null;
  saldoFinalCentavos: number;
  linhas: LinhaExtrato[];
  /** Instante de geração do arquivo: ISO 8601 com offset explícito (ex. 2026-11-20T10:15:00-03:00). */
  geradoEm: string;
}

export type MotivoRecusaParse =
  | 'formato_desconhecido'
  | 'campo_ausente'
  | 'valor_invalido'
  | 'data_invalida'
  | 'lancamento_nao_efetivado';

export type ResultadoParse =
  | { ok: true; extrato: ExtratoParseado }
  | { ok: false; motivo: MotivoRecusaParse; detalhe: string };

export function soDigitos(s: string): string {
  return s.replace(/\D/g, '');
}

export function normalizarDescricao(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Texto decimal -> valor ABSOLUTO em centavos (o sentido vem de outro lugar).
 * Aritmética de string/inteiro: nunca parseFloat. Ambíguo/inválido -> null (recusa, não chute).
 *  - com vírgula: decimal BR (pontos = milhar); no máximo 2 casas.
 *  - só ponto: exatamente 1-2 dígitos após o ÚNICO ponto = decimal; 3 dígitos ('12.345') = ambíguo.
 */
export function decimalTextoParaCentavos(s: string): number | null {
  let t = s.trim().replace(/\s+/g, '');
  if (t.startsWith('-') || t.startsWith('+')) t = t.slice(1);
  if (t === '') return null;
  let inteiro: string;
  let frac: string;
  if (t.includes(',')) {
    const partes = t.split(',');
    if (partes.length !== 2) return null;
    // milhar só bem posicionado: 1-3 dígitos + grupos de 3 (ou só dígitos, sem ponto)
    if (!/^\d+$/.test(partes[0]) && !/^\d{1,3}(\.\d{3})+$/.test(partes[0])) return null;
    inteiro = partes[0].replace(/\./g, '');
    frac = partes[1];
  } else if (t.includes('.')) {
    const partes = t.split('.');
    if (partes.length !== 2) return null; // 1.234.567 sem vírgula: ambíguo
    if (partes[1].length < 1 || partes[1].length > 2) return null; // 3+ dígitos: ambíguo / >2 casas
    inteiro = partes[0];
    frac = partes[1];
  } else {
    inteiro = t;
    frac = '';
  }
  if (inteiro === '') inteiro = '0';
  if (!/^\d+$/.test(inteiro)) return null;
  if (frac !== '' && !/^\d+$/.test(frac)) return null;
  if (frac.length > 2) return null;
  const centavos = Number(inteiro) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(centavos)) return null;
  return centavos;
}

export type EstrategiaChave = 'id_bancario' | 'tupla';

export function chavesDasLinhas(linhas: LinhaExtrato[], estrategia: EstrategiaChave): string[] | null {
  if (estrategia === 'id_bancario') {
    const vistos = new Set<string>();
    const chaves: string[] = [];
    for (const l of linhas) {
      if (l.idBancario === null || l.idBancario === '') return null;
      const chave = `id:${l.idBancario}`;
      if (vistos.has(chave)) return null;
      vistos.add(chave);
      chaves.push(chave);
    }
    return chaves;
  }
  const contagem = new Map<string, number>();
  return linhas.map((l) => {
    const base = `${l.data}|${l.sentido}|${l.valorCentavos}|${l.documento ?? ''}`;
    const ordinal = (contagem.get(base) ?? 0) + 1;
    contagem.set(base, ordinal);
    return `${base}|${ordinal}`;
  });
}

export function fecha(
  inicial: number,
  linhas: LinhaExtrato[],
  final: number,
): { fecha: boolean; diferencaCentavos: number } {
  let soma = inicial;
  for (const l of linhas) soma += l.sentido === 'C' ? l.valorCentavos : -l.valorCentavos;
  const diferencaCentavos = Math.abs(final - soma);
  return { fecha: diferencaCentavos === 0, diferencaCentavos };
}
