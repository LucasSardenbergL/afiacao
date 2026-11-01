// Telefone do cliente Omie — composição DDD + número e régua de reposição (precisão > recall).
//
// O Omie devolve o telefone em DOIS campos (`telefone1_ddd`, `telefone1_numero`). Esta edge
// gravava só o segundo em `profiles.phone`, e um número sem DDD não é telefone: a régua de
// cobrança (`/cobranca`, helper `telefoneWa`) exige 10–11 dígitos para montar o `wa.me`, então
// 91/95 perfis da coorte Oben saíam como "telefone inválido no cadastro" (medido 2026-11-01:
// 5.378 dos 5.668 perfis mapeados nas 3 contas estavam sem DDD). A `omie-vendas-sync` já compõe
// `(ddd) numero`; aqui a mesma composição vira módulo puro, testável sem rede (`--no-remote`).
//
// Regra: sem DDD válido, o telefone é `null` — NUNCA se grava o número pelado como se fosse
// completo, e NUNCA se inventa DDD. Ausente ≠ zero (money-path).

const NAO_DIGITO = /\D/g;

export function digitos(raw: string | null | undefined): string {
  return (raw ?? "").replace(NAO_DIGITO, "");
}

/** 10–11 dígitos nacionais → "(DD) NNNN-NNNN" ou "(DD) NNNNN-NNNN". Pré-condição: tamanho válido. */
function formatarNacional(d: string): string {
  const ddd = d.slice(0, 2);
  const corpo = d.slice(2);
  const corte = corpo.length - 4;
  return `(${ddd}) ${corpo.slice(0, corte)}-${corpo.slice(corte)}`;
}

/** DDD brasileiro: 2 dígitos, 11–99 (tolera "011"/"0xx" — zero de operadora à esquerda). */
function dddValido(raw: string | null | undefined): string | null {
  const d = digitos(raw).replace(/^0+/, "");
  return /^[1-9]\d$/.test(d) ? d : null;
}

/**
 * Normaliza um telefone que JÁ deveria vir completo (com DDD): aceita 10–11 dígitos, ou 12–13
 * com o `55` do país na frente (que é descartado). Qualquer outro tamanho → `null`.
 */
export function telefoneCompleto(raw: string | null | undefined): string | null {
  let d = digitos(raw);
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) return null;
  if (!/^[1-9]\d/.test(d)) return null;
  return formatarNacional(d);
}

/**
 * Compõe `telefone1_ddd` + `telefone1_numero` do Omie. DDD válido + número de 8–9 dígitos →
 * `(DD) NNNNN-NNNN`. Sem DDD utilizável, só aceita o número se ELE já vier completo (10–11
 * dígitos, ou 55+); senão `null`.
 */
export function telefoneOmie(ddd: string | null | undefined, numero: string | null | undefined): string | null {
  const dd = dddValido(ddd);
  const num = digitos(numero);
  if (dd && (num.length === 8 || num.length === 9)) return formatarNacional(dd + num);
  return telefoneCompleto(numero);
}

/** O perfil JÁ tem telefone completo (com DDD)? Só isso é "não mexer". */
export function telefoneTemDdd(atual: string | null | undefined): boolean {
  return telefoneCompleto(atual) !== null;
}

/**
 * Reposição: só quando o atual NÃO tem DDD (vazio, 8–9 dígitos, lixo) E o Omie fornece um
 * completo. Nunca sobrescreve um telefone já completo — pode ter sido corrigido à mão.
 */
export function deveReporTelefone(atual: string | null | undefined, novo: string | null): boolean {
  return novo !== null && !telefoneTemDdd(atual);
}
