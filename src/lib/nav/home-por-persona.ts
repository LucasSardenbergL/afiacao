/**
 * Decisões de navegação por persona comercial — helpers puros (TDD).
 *
 * `resolverHomeStaff`: pra onde a home `/` deve levar um STAFF. Vendedora
 * (farmer/hunter/closer/operacional, ou CPF sales-only) trabalha no Meu Dia
 * (fila do dia, positivação, SLA WhatsApp, tarefas, agenda) — o cockpit de
 * 6 módulos da empresa é a home de gestor/master/staff genérico.
 *
 * `itemVisivelParaSalesOnly`: substitui a regra antiga do AppShell que
 * filtrava por TÍTULO de seção (`section.title !== 'Vendas'`) e tornava o
 * Meu Dia e a carteira de Clientes (seção Principal) INALCANÇÁVEIS pela
 * vendedora sales-only.
 */

/** Cargos comerciais que vivem no Meu Dia (dashboards de vendedora do CommercialDashboard). */
const CARGOS_VENDEDORA = new Set(['farmer', 'hunter', 'closer', 'operacional']);

export interface SinaisHomeStaff {
  /** commercial_role efetivo (real, ou do alvo na lente "Ver como"). Vem CRU do banco
   *  em runtime — pode conter valores fora do union TS legado (farmer/hunter/closer). */
  commercialRole: string | null;
  /** CPF na lista company_config.sales_only_cpfs (efetivo: real ou do alvo na lente). */
  isSalesOnly: boolean;
}

/** Destino da home pra staff: '/meu-dia' (vendedora) ou null (mantém o cockpit). */
export function resolverHomeStaff({ commercialRole, isSalesOnly }: SinaisHomeStaff): '/meu-dia' | null {
  // Sales-only domina: o menu dela esconde os outros módulos — home cockpit é incoerente.
  if (isSalesOnly) return '/meu-dia';
  if (commercialRole && CARGOS_VENDEDORA.has(commercialRole)) return '/meu-dia';
  // gerencial/estrategico/super_admin/master, sem cargo ou cargo desconhecido → cockpit.
  return null;
}

/** Título da seção de Vendas no nav — contrato entre o AppShell e o filtro sales-only.
 *  Renomear a seção SÓ por aqui (string solta nos dois lados quebraria o menu mudo). */
export const SECAO_VENDAS = 'Vendas';

/** Paths fora da seção Vendas que a vendedora sales-only PRECISA alcançar. */
export const PATHS_EXTRAS_SALES_ONLY: readonly string[] = ['/meu-dia', '/admin/customers'];

/** Item de nav visível pra sales-only? Toda a seção Vendas + allowlist de extras. */
export function itemVisivelParaSalesOnly(sectionTitle: string, path: string): boolean {
  if (sectionTitle === SECAO_VENDAS) return true;
  return PATHS_EXTRAS_SALES_ONLY.includes(path);
}
