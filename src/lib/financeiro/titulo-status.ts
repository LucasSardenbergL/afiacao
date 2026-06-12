/**
 * Classificação de `status_titulo` de contas a pagar/receber (fin_contas_pagar /
 * fin_contas_receber).
 *
 * ⚠️ VOCABULÁRIO REAL DO BANCO = valores NATIVOS do Omie. O sync (omie-financeiro)
 * grava o `status_titulo` do Omie quase cru (a "normalização" dele só mapeia
 * 'ABERTO'→'VENCIDO', mas o Omie nunca manda 'ABERTO' — manda 'A VENCER' — então
 * passa direto). O frontend (financeiroService) e o banco já falam esse vocabulário.
 *
 * 🐛 BUG HISTÓRICO (corrigido por este helper): a engine de cashflow filtrava
 * títulos em aberto por `['ABERTO','PARCIAL','VENCIDO']` — valores que NUNCA
 * existem nos dados → 0 match → NCG=0 e projeção 13s vazia pras 3 empresas.
 *
 * ⚠️ NÃO incluir 'RECEBIDO'/'PAGO'/'LIQUIDADO' no conjunto de aberto: o `saldo`
 * é coluna GERADA (`valor_documento - COALESCE(valor_recebido,0)`) e `valor_recebido`
 * é SEMPRE 0 no banco (issue #396 — o LIST do Omie não traz a baixa), então títulos
 * liquidados têm `saldo` = valor cheio. Contá-los como aberto infla o NCG em dezenas
 * de milhões (ex.: colacor 'RECEBIDO' = R$17,5M). O guard correto é por STATUS, não
 * por saldo.
 *
 * ⚠️ Espelhado VERBATIM no Deno em supabase/functions/fin-cashflow-engine/index.ts.
 * Ao editar aqui, edite lá também.
 */

/**
 * Títulos EM ABERTO (compõem AR/AP: NCG, projeção). Valores nativos do Omie
 * + os FALLBACKS que o próprio ingest pode gravar (retroativo Codex 2026-06-11):
 * o omie-financeiro faz `status_titulo || 'ABERTO'` quando o Omie não manda
 * status e converte 'ABERTO' já vencido em 'VENCIDO'; 'PARCIAL' = baixa
 * parcial. Investigação anterior não achou esses valores em prod (o Omie
 * sempre manda 'A VENCER' etc.), mas o caminho de código EXISTE — sem eles
 * aqui, um título sem status sumiria do KPI/DSO/capital de giro em silêncio.
 * `saldo` é coluna gerada (doc − recebido) → correto pros 3 (PARCIAL conta o
 * remanescente quando houver valor_recebido).
 */
export const OPEN_TITLE_STATUSES = ['A VENCER', 'ATRASADO', 'VENCE HOJE', 'ABERTO', 'VENCIDO', 'PARCIAL'] as const;

/** Aberto mas NÃO vencido (exclui 'ATRASADO'/'VENCIDO'). Usado só p/ adiantamentos. */
export const OPEN_NOT_OVERDUE_TITLE_STATUSES = ['A VENCER', 'VENCE HOJE', 'ABERTO'] as const;

/** Liquidados (NÃO entram em aberto — saldo é bogus por causa do #396). */
export const SETTLED_TITLE_STATUSES = ['RECEBIDO', 'PAGO', 'LIQUIDADO'] as const;

const OPEN_SET = new Set<string>(OPEN_TITLE_STATUSES);
const OPEN_NOT_OVERDUE_SET = new Set<string>(OPEN_NOT_OVERDUE_TITLE_STATUSES);
const SETTLED_SET = new Set<string>(SETTLED_TITLE_STATUSES);

/** Título compõe AR/AP em aberto (NCG, projeção, concentração). */
export function isOpenTitleStatus(status: string | null | undefined): boolean {
  return status != null && OPEN_SET.has(status);
}

/** Aberto e ainda não vencido (adiantamentos: prepagamento não conta como vencido). */
export function isOpenNotOverdueTitleStatus(status: string | null | undefined): boolean {
  return status != null && OPEN_NOT_OVERDUE_SET.has(status);
}

export type TituloStatusClass = 'open' | 'settled' | 'cancelled' | 'unknown';

/**
 * Classifica p/ telemetria de qualidade de dado. 'unknown' = status novo do Omie
 * que não conhecemos (alerta de data-quality; NÃO conta como aberto — fail-safe).
 */
export function classifyTituloStatus(status: string | null | undefined): TituloStatusClass {
  if (status == null) return 'unknown';
  if (OPEN_SET.has(status)) return 'open';
  if (SETTLED_SET.has(status)) return 'settled';
  if (status === 'CANCELADO') return 'cancelled';
  return 'unknown';
}
