// CNPJ alfanumérico (RFB, desde jul/2026): 12 posições [0-9A-Z] + 2 dígitos verificadores.
// Espelho Deno de `src/lib/radar/normalizar.ts` (a edge não importa `src/`). Mantenha os dois
// iguais — o teste `cnpj_test.ts` fixa o exemplo OFICIAL da RFB (12.ABC.345/01DE-35) como oráculo.
//
// DV: módulo 11 sobre o valor (código ASCII − 48) de cada caractere — dígito vale o próprio valor,
// 'A'..'Z' valem 17..42 — pesos 5,4,3,2,9,8,7,6,5,4,3,2 (DV1) e 6,5,4,3,2,9,8,7,6,5,4,3,2 (DV2);
// resto < 2 → 0, senão 11 − resto. Para CNPJ só-numérico coincide com a regra clássica.

export const CNPJ_RE = /^[0-9A-Z]{12}[0-9]{2}$/;
const BASE_RE = /^[0-9A-Z]{12}$/;
const PESOS_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function digito(valores: number[], pesos: number[]): number {
  const resto = valores.reduce((acc, v, i) => acc + v * pesos[i], 0) % 11;
  return resto < 2 ? 0 : 11 - resto;
}

/** Os 2 DVs da base de 12 posições, ou null se a base não for [0-9A-Z]{12}. */
export function dvCnpj(base12: string): string | null {
  if (!BASE_RE.test(base12)) return null;
  const valores = Array.from(base12, (c) => c.charCodeAt(0) - 48);
  const d1 = digito(valores, PESOS_1);
  const d2 = digito([...valores, d1], PESOS_2);
  return `${d1}${d2}`;
}

/** Formato novo E DV correto. Minúscula não é normalizada — é inválida (fail-closed). */
export function cnpjValido(cnpj: string): boolean {
  return CNPJ_RE.test(cnpj) && dvCnpj(cnpj.slice(0, 12)) === cnpj.slice(12);
}

export type MotivoDescarte = "cnpj_formato" | "cnpj_dv" | "cnae";

/** Por que uma linha do chunk seria descartada — null quando é válida. A ordem importa:
 *  formato antes de DV (um CNPJ fora do formato não tem DV a conferir), CNAE por último. */
export function motivoDescarte(cnpj: unknown, cnaePrincipal: unknown): MotivoDescarte | null {
  const c = String(cnpj ?? "");
  if (!CNPJ_RE.test(c)) return "cnpj_formato";
  if (dvCnpj(c.slice(0, 12)) !== c.slice(12)) return "cnpj_dv";
  if (!/^\d{7}$/.test(String(cnaePrincipal ?? ""))) return "cnae";
  return null;
}
