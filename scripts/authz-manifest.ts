/**
 * authz-manifest.ts — contrato de autorização das RPCs SECURITY DEFINER sensíveis.
 * ============================================================================================
 *
 * Fonte de verdade CURADA do check anti-regressão de gate (scripts/authz-gate-check.ts).
 * Cada função SECDEF que toca custo/preço/estoque e é EXECUTÁVEL por `authenticated` DEVE estar
 * aqui, com o gate de bloqueio esperado. O check garante que nenhuma migration recrie a função
 * sem esse gate (Parte A) e que nenhuma SECDEF sensível nova fique sem classificação (Parte B).
 *
 * Ao adicionar/gatear uma função SECDEF sensível: classifique-a aqui (o CI falha até você fazê-lo).
 * Ao MUDAR o gate de uma função (decisão de política): atualize o requiredGate aqui — é o ponto
 * de revisão consciente. Chave = `schema.name` (sem assinatura: overloads compartilham o gate).
 *
 * Semeado 2026-07-09 a partir do inventário PROD (psql-ro) — todas gateadas na criação do check.
 */
import type { RequiredGate } from './lib/authz-contract';

export interface AuthzEntry {
  sensitive: true;
  requiredGate: RequiredGate;
  motivo: string;
}

export const AUTHZ_MANIFEST: Record<string, AuthzEntry> = {
  // E2/FU4 (2026-07-18): estas duas leem CUSTO, e o gate único `pode_ver_carteira_completa`
  // as concedia ao papel gerencial operacional junto com preço e crédito. Passaram a exigir
  // `private.cap_custo_ler` — master + estrategico + super_admin. Mudança de POLÍTICA revisada
  // conscientemente aqui, como manda o cabeçalho deste arquivo.
  'public.fin_estimar_estoque_omie': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_custo_ler' }] },
    motivo: 'capital imobilizado em estoque a custo (Σ saldo×cmc) — PR #1264; E2/FU4 estreitou p/ estrategico+',
  },
  'public.medir_abaixo_piso_tier': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_custo_ler' }] },
    motivo: 'folga negativa de margem vs piso de markup — cockpit financeiro; E2/FU4 estreitou p/ estrategico+',
  },
  'public.get_preco_cockpit': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }, { call: 'pode_ver_carteira_completa' }] },
    motivo: 'cockpit de preços — bloqueia staff; pode_ver_carteira_completa afina o detalhe',
  },
  'public.get_defasagem_cliente': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }, { call: 'pode_ver_carteira_completa' }] },
    motivo: 'defasagem de preço por cliente vs custo',
  },
  'public.get_regua_preco': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'régua de preço/markup a partir do cmc',
  },
  'public.get_regua_preco_customer360': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'régua de preço no customer 360',
  },
  'public.get_ultimos_precos_cliente': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'últimos preços praticados por cliente',
  },
  'public.melhoria_clientes_por_produto': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'clientes por produto (preço/volume 12m)',
  },
};

/**
 * SECDEF que tocam dado sensível mas NÃO precisam de gate customer-facing — baseline 2026-07-09.
 * Cada entrada é uma decisão consciente: a função não é executável por `authenticated` (só
 * service_role/cron/staff-internal) OU o "toque" é falso-positivo do parser (menção em string
 * já mascarada / coluna homônima). Justificativa por linha. Semeado a partir do inventário PROD
 * (psql-ro: 20 SECDEF tocam sensível, 8 expostas a authenticated = o AUTHZ_MANIFEST acima).
 * v2: auditar cada uma individualmente e cruzar com os grants reais.
 */
export const ACKNOWLEDGED_SENSITIVE = new Set<string>([
  // Baseline 2026-07-09: as 7 SECDEF abaixo tocam custo/preço/estoque mas NÃO são executáveis por
  // authenticated nem anon (confirmado psql-ro: auth_exec=f, anon_exec=f) — service_role/cron/
  // trigger/interno, não customer-facing. Vazamento customer-facing exige EXECUTE p/ authenticated.
  'public._data_health_compute', // cômputo de saúde de dados (cron/service_role)
  'public.tint_promote_sync_run', // sync tintométrico → promoção (service_role)
  'public.tint_calc_preco_final', // cálculo de preço tint, chamado pelo sync (interno)
  'public.tint_recalc_preco_oficial', // recálculo de preço oficial tint (interno)
  'public.aplicar_snapshot_pendente', // aplica snapshot de reposição (cron/service_role)
  'public.cmc_ledger_capture', // captura no ledger de cmc (trigger/service_role)
  'public.reposicao_cold_start_parametros', // parâmetros cold-start da reposição (interno)
]);

/** chave de lookup a partir de schema+name (case-insensitive, sem assinatura) */
export function manifestKey(schema: string, name: string): string {
  return `${schema}.${name}`.toLowerCase();
}
