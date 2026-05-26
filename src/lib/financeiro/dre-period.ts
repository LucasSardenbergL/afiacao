/**
 * Validação/coerção do período (ano/mes/meses) do DRE.
 *
 * SEGURANÇA: o engine `omie-financeiro` interpola `ano`/`mes` cru num predicado
 * `.or()` do PostgREST pra montar `data.gte.${inicioMes}` (calcularDRE). Como o
 * body JSON do Deno não valida o tipo em runtime, um `mes` string tipo
 * `"01),or(id.gte.0"` quebraria o `and(...)` e injetaria filtro — e como o
 * calcularDRE faz UPSERT em `fin_dre_snapshots`, um período malformado também
 * persistiria DRE incorreta. Estes helpers fecham os dois: exigem inteiro no
 * intervalo válido e fazem THROW no input presente-mas-inválido (degradação
 * honesta — em money-path, errar ruidosamente é melhor que cair num default
 * silencioso e gravar o período errado).
 *
 * Contrato: campo AUSENTE → usa o default contratado; campo PRESENTE e inválido
 * → `DrePeriodError` (o handler mapeia pra HTTP 400).
 *
 * ⚠️ Espelhado VERBATIM no Deno em `supabase/functions/omie-financeiro/index.ts`
 * (mesma disciplina do §FinanceiroProgram). Ao editar aqui, edite lá também.
 */

export class DrePeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrePeriodError';
  }
}

function asInteger(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new DrePeriodError(`${field} deve ser inteiro (recebido: ${value})`);
    }
    return value;
  }
  if (typeof value === 'string') {
    const t = value.trim();
    if (!/^\d+$/.test(t)) {
      throw new DrePeriodError(`${field} inválido (recebido: "${value}")`);
    }
    return Number(t);
  }
  throw new DrePeriodError(`${field} inválido (recebido: ${String(value)})`);
}

export function validateAno(ano: unknown): number {
  const n = asInteger(ano, 'ano');
  if (n < 2000 || n > 2100) {
    throw new DrePeriodError(`ano fora do intervalo 2000-2100 (recebido: ${n})`);
  }
  return n;
}

export function validateMes(mes: unknown): number {
  const n = asInteger(mes, 'mes');
  if (n < 1 || n > 12) {
    throw new DrePeriodError(`mes fora do intervalo 1-12 (recebido: ${n})`);
  }
  return n;
}

export interface DrePeriodInput {
  ano?: unknown;
  mes?: unknown;
  meses?: unknown;
  /** Default contratado quando `ano` está ausente (ex.: ano corrente). */
  defaultAno: number;
  /** Default contratado quando `mes` e `meses` estão ausentes (ex.: mês corrente). */
  defaultMes: number;
}

/**
 * Resolve o período do DRE a partir do input do request.
 * - `ano` ausente → `defaultAno`; presente → validado.
 * - `meses` (array) tem precedência sobre `mes`; ambos ausentes → `[defaultMes]`.
 * - Qualquer valor presente e inválido → `DrePeriodError`.
 */
export function resolveDrePeriod(input: DrePeriodInput): { ano: number; meses: number[] } {
  const ano = input.ano == null ? input.defaultAno : validateAno(input.ano);

  let meses: number[];
  if (input.meses != null) {
    if (!Array.isArray(input.meses)) {
      throw new DrePeriodError('meses deve ser um array de inteiros');
    }
    if (input.meses.length === 0) {
      throw new DrePeriodError('meses não pode ser vazio');
    }
    meses = input.meses.map((m) => validateMes(m));
  } else if (input.mes != null) {
    meses = [validateMes(input.mes)];
  } else {
    meses = [input.defaultMes];
  }

  return { ano, meses };
}
