// CNPJ alfanumérico (RFB, desde jul/2026): 12 posições [0-9A-Z] + 2 dígitos verificadores.
// Espelho Deno de `src/lib/radar/normalizar.ts` / `radar-ingest/cnpj.ts` para os ESCRITORES das
// fontes de cliente do Radar (`omie_clientes_nao_vinculados.cnpj_cpf`, lookups por documento).
// Mantenha os espelhos iguais — `cnpj-alfanumerico_test.ts` fixa o exemplo OFICIAL da RFB
// (12.ABC.345/01DE-35) como oráculo.
//
// DV: módulo 11 sobre o valor (código ASCII − 48) de cada caractere — dígito vale o próprio valor,
// 'A'..'Z' valem 17..42 — pesos 5,4,3,2,9,8,7,6,5,4,3,2 (DV1) e 6,5,4,3,2,9,8,7,6,5,4,3,2 (DV2);
// resto < 2 → 0, senão 11 − resto. Para CNPJ só-numérico coincide com a regra clássica.

export const CNPJ_RE = /^[0-9A-Z]{12}[0-9]{2}$/;
/** Máscara RFB nas posições exatas (`12.ABC.345/01DE-35`) — o MESMO regex das migrations 20261019140000/150000. */
const CNPJ_MASCARA_RE = /^[0-9A-Z]{2}[.][0-9A-Z]{3}[.][0-9A-Z]{3}\/[0-9A-Z]{4}-[0-9]{2}$/;
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
 *   · CPF/CNPJ NUMÉRICO (com ou sem máscara) → só-dígitos, BYTE-IDÊNTICO ao `.replace(/\D/g, "")`
 *     que os escritores sempre fizeram — nada muda para o acervo de hoje.
 *   · CNPJ ALFANUMÉRICO VÁLIDO (formato RFB jul/2026 + DV mod-11) → btrim + upper e, SÓ se o todo
 *     for o documento CRU (14 posições) ou a máscara nas POSIÇÕES EXATAS (`12.ABC.345/01DE-35`),
 *     remove os separadores (. - /) preservando as letras. É exatamente a chave `alnum` de
 *     `radar_recruzar_ja_cliente()` (migration 20261019150000) e de `normalizar_documento()`
 *     (20261019140000). Separador FORA da posição da máscara não é tirado, de propósito: remover
 *     `[-./]` de qualquer posição transformava "aeg-123.456.789-09" (CPF com anotação) em
 *     AEG12345678909, cujo DV confere por coincidência (Codex retroativo do #3175, PR #3192) — e
 *     espaço interno tampouco é separador ("aeg 123.456.789-09" não vira chave).
 *   · Qualquer outra coisa com letra (DV errado, formato errado, máscara fora de posição) →
 *     só-dígitos como hoje. Não se fabrica documento; o que já era lixo continua lixo do mesmo
 *     jeito (precisão > recall).
 */
export function normalizarDocumento(bruto: unknown): string {
  const s = String(bruto ?? "");
  const d = s.trim().toUpperCase();
  if (CNPJ_RE.test(d) || CNPJ_MASCARA_RE.test(d)) {
    const alnum = d.replace(/[-./]/g, "");
    if (ehCnpjAlfanumerico(alnum)) return alnum;
  }
  return s.replace(/\D/g, "");
}

/**
 * Documento para CADASTRAR cliente no Omie (IncluirCliente). O ramo `pessoa_fisica = len <= 11`
 * dos chamadores tratava `12ABC34501DE36` (letra, DV errado) como "CPF" de 9 dígitos e cadastrava
 * ERRADO no ERP — e `123ABC45678909` como o CPF 12345678909 de OUTRA pessoa (Codex, 2026-10-19).
 * Regra: letra só é tolerada como RÓTULO antes do 1º dígito ("CPF: 123..."); letra DEPOIS do 1º
 * dígito só passa se o todo for um CNPJ alfanumérico válido — senão lança (precisão > recall: um
 * cadastro errado no ERP custa mais que um recusado). Numérico puro/com máscara segue byte-idêntico.
 */
export function documentoParaCadastro(bruto: unknown): string {
  const doc = normalizarDocumento(bruto);
  const s = String(bruto ?? "");
  const corpo = s.slice(Math.max(0, s.search(/\d/)));
  if (/[A-Za-z]/.test(corpo) && !ehCnpjAlfanumerico(doc)) {
    throw new Error("Documento com letras não é um CNPJ alfanumérico válido (RFB jul/2026) — cadastro recusado");
  }
  return doc;
}
