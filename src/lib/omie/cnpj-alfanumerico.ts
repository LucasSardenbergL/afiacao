// CNPJ alfanumérico (RFB, desde jul/2026): 12 posições [0-9A-Z] + 2 dígitos verificadores.
// Espelho em `src/` de `supabase/functions/_shared/cnpj-alfanumerico.ts` (o edge não importa de src/ e
// vice-versa) — mesmo contrato para o front e para os espelhos de teste (clientes-nao-vinculados/snapshot).
// Mantenha os espelhos iguais — o teste fixa o exemplo OFICIAL da RFB
// (12.ABC.345/01DE-35) como oráculo.
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

/** Formato novo E DV correto. Minúscula não é normalizada aqui — é inválida (fail-closed). */
export function cnpjValido(cnpj: string): boolean {
  return CNPJ_RE.test(cnpj) && dvCnpj(cnpj.slice(0, 12)) === cnpj.slice(12);
}

/** True só para um CNPJ alfanumérico VÁLIDO que tem ao menos uma letra (o numérico não conta). */
export function ehCnpjAlfanumerico(doc: string): boolean {
  return /[A-Z]/.test(doc) && cnpjValido(doc);
}

/**
 * Normaliza um documento de cliente (CPF/CNPJ) para gravar/comparar.
 *
 *   · CPF/CNPJ NUMÉRICO (com ou sem máscara) → só-dígitos, BYTE-IDÊNTICO ao `.replace(/\D/g, '')`
 *     que os escritores sempre fizeram — nada muda para o acervo de hoje.
 *   · CNPJ ALFANUMÉRICO VÁLIDO (formato RFB jul/2026 + DV mod-11) → btrim + upper + remove SÓ os
 *     separadores da máscara (. - /), preservando as letras. É exatamente a chave `alnum` que
 *     `radar_recruzar_ja_cliente()` deriva (migration 20261019110000) — espaço INTERNO não é
 *     separador, de propósito (contraexemplo do Codex: 'aeg 123.456.789-09' não vira chave).
 *   · Qualquer outra coisa com letra (DV errado, formato errado) → só-dígitos como hoje. Não se
 *     fabrica documento; o que já era lixo continua lixo do mesmo jeito (precisão > recall).
 */
export function normalizarDocumento(bruto: unknown): string {
  const s = String(bruto ?? '');
  const alnum = s.trim().toUpperCase().replace(/[-./]/g, '');
  if (ehCnpjAlfanumerico(alnum)) return alnum;
  return s.replace(/\D/g, '');
}
