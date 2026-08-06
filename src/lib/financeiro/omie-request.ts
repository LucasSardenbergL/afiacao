/**
 * Validação de parâmetros de request do engine `omie-financeiro`.
 *
 * SEGURANÇA/INTEGRIDADE: `company`/`companies` vêm do body JSON e são usados em
 * `.eq("company", ...)`, como chave do upsert de snapshot e como chave do objeto
 * de resultado. Embora o supabase-js encode o valor do `.eq()` (não há injeção
 * estrutural como no `.or()`), uma empresa fora do conjunto conhecido produz
 * resultado vazio / chave-lixo silenciosa. Aqui validamos contra o allow-list e
 * fazemos THROW no input inválido (mapeado pra HTTP 400 no handler).
 *
 * ⚠️ Espelhado VERBATIM no Deno em `supabase/functions/omie-financeiro/index.ts`
 * (mesma disciplina do §FinanceiroProgram). Ao editar aqui, edite lá também.
 */

export class OmieRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmieRequestError';
  }
}

function validateCompany(value: unknown, allowed: readonly string[]): string {
  if (typeof value === 'string' && allowed.includes(value)) {
    return value;
  }
  throw new OmieRequestError(`company inválida (recebido: ${JSON.stringify(value)})`);
}

export interface ResolveCompaniesInput {
  companies?: unknown;
  company?: unknown;
  /** Conjunto permitido (ex.: ["oben","colacor","colacor_sc"]). */
  allowed: readonly string[];
}

/**
 * Resolve a lista-alvo de empresas validando contra o allow-list.
 * - `companies` (array) tem precedência; cada item deve estar no allow-list.
 * - senão `company` único validado.
 * - ambos ausentes → todas as permitidas.
 * Qualquer valor presente e inválido (fora do allow-list, vazio, não-array,
 * tipo errado) → `OmieRequestError`.
 */
export function resolveCompanies(input: ResolveCompaniesInput): string[] {
  const { companies, company, allowed } = input;

  if (companies != null) {
    if (!Array.isArray(companies)) {
      throw new OmieRequestError('companies deve ser um array');
    }
    if (companies.length === 0) {
      throw new OmieRequestError('companies não pode ser vazio');
    }
    return companies.map((c) => validateCompany(c, allowed));
  }

  if (company != null) {
    return [validateCompany(company, allowed)];
  }

  return [...allowed];
}

/**
 * Conjunto de `commercial_role` que contam como "gestor comercial" pra acesso
 * financeiro. Espelha o gate canônico do `fin-valor-cockpit`/`fin-next-best-action`.
 */
const GESTOR_COMMERCIAL_ROLES = ['gerencial', 'estrategico', 'super_admin'] as const;

/**
 * Gate de acesso ao engine financeiro (`omie-financeiro`): expõe DRE/saldos/CP-CR
 * + sync com o ERP, então NÃO é pra employee comum. Autoriza se o usuário é
 * `master` (user_roles) OU gestor comercial (commercial_roles em
 * GESTOR_COMMERCIAL_ROLES). Deny-by-default (null/vazio → false).
 *
 * Decisão de matriz: founder (2026-05-25). Não confere RLS/tenant — a verdade do
 * dado vem das queries `.eq("company", ...)`; isto é só o gate de quem-pode-chamar.
 */
export function hasFinanceiroAccess(input: {
  userRoles: ReadonlyArray<{ role?: string | null }> | null | undefined;
  commercialRoles: ReadonlyArray<{ commercial_role?: string | null }> | null | undefined;
}): boolean {
  const isMaster = (input.userRoles ?? []).some((r) => r?.role === 'master');
  if (isMaster) return true;
  const gestor = new Set<string>(GESTOR_COMMERCIAL_ROLES);
  return (input.commercialRoles ?? []).some(
    (c) => c?.commercial_role != null && gestor.has(c.commercial_role),
  );
}
