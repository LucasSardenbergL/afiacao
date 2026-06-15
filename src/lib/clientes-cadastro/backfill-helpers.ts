// Helpers puros do backfill de cadastro Omie → profiles (clientes-fantasma da carteira).
// ESPELHADO verbatim na action `start_backfill_cadastro` do edge omie-analytics-sync
// (Deno não importa de src/). Spec: docs/superpowers/specs/2026-06-12-clientes-cadastro-backfill-design.md
//
// Princípio: o backfill só dá NOME a contas que já existem (auth.users + omie_clientes).
// Nunca cria auth, nunca reaponta carteira, nunca atualiza profile existente.

/** DV de CPF (mod 11). Recebe 11 dígitos já sem sentinela. */
function cpfDvValido(cpf: string): boolean {
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += Number(cpf[i]) * (10 - i);
  let resto = soma % 11;
  const dv1 = resto < 2 ? 0 : 11 - resto;
  if (dv1 !== Number(cpf[9])) return false;
  soma = 0;
  for (let i = 0; i < 10; i++) soma += Number(cpf[i]) * (11 - i);
  resto = soma % 11;
  const dv2 = resto < 2 ? 0 : 11 - resto;
  return dv2 === Number(cpf[10]);
}

/** DV de CNPJ (mod 11, pesos padrão). Recebe 14 dígitos já sem sentinela. */
function cnpjDvValido(cnpj: string): boolean {
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const p2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let soma = 0;
  for (let i = 0; i < 12; i++) soma += Number(cnpj[i]) * p1[i];
  let resto = soma % 11;
  const dv1 = resto < 2 ? 0 : 11 - resto;
  if (dv1 !== Number(cnpj[12])) return false;
  soma = 0;
  for (let i = 0; i < 13; i++) soma += Number(cnpj[i]) * p2[i];
  resto = soma % 11;
  const dv2 = resto < 2 ? 0 : 11 - resto;
  return dv2 === Number(cnpj[13]);
}

/**
 * Só dígitos; aceita CPF (11) ou CNPJ (14) com DÍGITO VERIFICADOR válido; rejeita sentinela
 * (todos iguais). Documento com DV inválido (erro de digitação no Omie) → null: o backfill o trata
 * como ausência (document=NULL), nunca como identidade fiscal real (evita colisão falsa e lixo).
 */
export function normalizarDocumento(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length !== 11 && d.length !== 14) return null;
  if (/^(\d)\1+$/.test(d)) return null; // 000…/111… = lixo de cadastro, nunca identidade real
  if (d.length === 11 && !cpfDvValido(d)) return null;
  if (d.length === 14 && !cnpjDvValido(d)) return null;
  return d;
}

/** Junta DDD + número (só dígitos). Curto demais (< 8) → null. */
export function montarTelefone(
  ddd: string | null | undefined,
  numero: string | null | undefined,
): string | null {
  const full = ((ddd ?? '') + (numero ?? '')).replace(/\D/g, '');
  return full.length >= 8 ? full : null;
}

export interface CadastroOmie {
  razao_social?: string | null;
  nome_fantasia?: string | null;
  cnpj_cpf?: string | null;
  telefone_ddd?: string | null;
  telefone_numero?: string | null;
}

export interface ProfileRow {
  user_id: string;
  name: string;
  phone: string | null;
  document: string | null;
  customer_type: string | null;
  prospect_source: 'omie_import';
  is_employee: false;
  is_approved: false;
  created_at: string;
}

export type MotivoPular =
  | 'master_cnpj'
  | 'doc_em_outro_profile'
  | 'doc_duplicado_no_lote';

export type DecisaoBackfill =
  | { acao: 'inserir'; row: ProfileRow }
  | { acao: 'pular'; motivo: MotivoPular };

export interface DecidirArgs {
  userId: string;
  /** auth.users.created_at — preservar a data REAL (março), nunca a do backfill (distorceria o score de visita). */
  authCreatedAt: string;
  cadastro: CadastroOmie;
  /** company_config.master_cnpj — documento que o trigger promove a master. */
  masterCnpj: string | null;
  /** documentos normalizados que JÁ existem em profiles (dedup vs base). */
  docsExistentes: Set<string>;
  /** documentos normalizados já decididos NESTE lote (dedup intra-lote; o chamador adiciona após cada 'inserir'). */
  docsNoLote: Set<string>;
}

/**
 * Decide a linha de profile de UM cliente-fantasma. Precedência:
 *   master_cnpj (segurança) > dedup-existente > dedup-lote > inserir.
 * Documento inválido NÃO bloqueia: insere com document=NULL (o vínculo canônico é user_id+omie_clientes).
 */
export function decidirLinhaProfile(args: DecidirArgs): DecisaoBackfill {
  const { userId, authCreatedAt, cadastro, masterCnpj, docsExistentes, docsNoLote } = args;
  const doc = normalizarDocumento(cadastro.cnpj_cpf);

  if (doc) {
    const masterNorm = (masterCnpj ?? '').replace(/\D/g, '');
    if (masterNorm && doc === masterNorm) return { acao: 'pular', motivo: 'master_cnpj' };
    if (docsExistentes.has(doc)) return { acao: 'pular', motivo: 'doc_em_outro_profile' };
    if (docsNoLote.has(doc)) return { acao: 'pular', motivo: 'doc_duplicado_no_lote' };
  }

  const nome = (cadastro.nome_fantasia?.trim() || cadastro.razao_social?.trim() || '').trim();
  const row: ProfileRow = {
    user_id: userId,
    name: nome || 'Cliente',
    phone: montarTelefone(cadastro.telefone_ddd, cadastro.telefone_numero),
    document: doc,
    customer_type: null, // app infere PJ/PF do documento; não inventar 'industrial'
    prospect_source: 'omie_import',
    is_employee: false,
    is_approved: false,
    created_at: authCreatedAt,
  };
  return { acao: 'inserir', row };
}
