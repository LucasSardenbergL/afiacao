/**
 * Objetivo estratégico do plano tático do farmer — rótulo categórico que entra no
 * prompt da IA (`generate-tactical-plan`) e molda o plano de abordagem.
 *
 * Regras em ORDEM (a primeira que casa vence):
 *   0. ativacao    — sem_historico: sem venda válida no resumo (PRECEDE tudo; nada p/ recuperar)
 *   1. reativacao  — cliente LAPSADO: dormência ≥ teto de recência (recência saturada em 0)
 *   2. recuperacao — churn alto (cliente escorregando, mas recência ainda viva)
 *   3. expansao_mix · 4. consolidacao_margem · 5. upsell_premium
 *
 * Por que `daysSince >= recencyCapDays`, e não um `> 90` fixo:
 * a recência (componente de 25% do health_score; churn = 100 − health) zera
 * LINEARMENTE em T = `hs_recency_cap_days` (default 180) e fica PLANA daí pra frente.
 * Abaixo de T o sinal de churn ainda carrega informação → a lente certa é `recuperacao`.
 * Em T o sinal satura: a troca de regime pra `reativacao` deixa de ser um número mágico
 * (90, descolado do modelo) e passa a coincidir com o ponto onde o sinal contínuo morre.
 * Usa `>=` porque em days = T a recência ACABOU de zerar (lapsado pleno). O gate de dias
 * vem ANTES do churn de propósito: resgata o cliente "dormente mas forte no histórico"
 * (recência 0, mas margem/frequência altas → churn pode ser baixo e não disparar `recuperacao`).
 *
 * money-path LEVE: afeta priorização/plano do farmer, não dinheiro direto. Fronteira
 * alinhada ao teto via /codex consult (2026-06-20): ancorar na saturação (não na meia-vida)
 * e LER o teto do config (não hardcode), pra a fronteira ACOMPANHAR o modelo se o operador
 * retunar T. Ver docs/historico/bugs-resolvidos.md.
 */
export function selectObjective(
  churnRisk: number,
  mixGap: number,
  marginPct: number,
  clusterMargin: number,
  daysSince: number,
  recencyCapDays: number,
  salesHistoryStatus: string | null = null,
): string {
  if (salesHistoryStatus === 'sem_historico') return 'ativacao'; // sem venda válida → ativação (nada p/ recuperar/reativar)
  if (daysSince >= recencyCapDays) return 'reativacao';
  if (churnRisk > 60) return 'recuperacao';
  if (mixGap > 3) return 'expansao_mix';
  if (marginPct < clusterMargin * 0.8) return 'consolidacao_margem';
  return 'upsell_premium';
}

const DEFAULT_RECENCY_CAP_DAYS = 180;
const MIN_RECENCY_CAP_DAYS = 30;
const MAX_RECENCY_CAP_DAYS = 999;

/**
 * Teto de recência (dias até a recência zerar), lido de
 * `farmer_algorithm_config.hs_recency_cap_days`. Default 180, guardrail [30, 999].
 * Ausente/null/NaN → default (Number(null) === 0 fabricaria a fronteira mínima de 30).
 *
 * ⚠️ DUPLICATA TEMPORÁRIA da `clampRecencyCapDays` canônica em
 * `src/lib/scoring/recency.ts` (commit fccc7a96 / branch agitated-panini — ainda NÃO
 * mergeada neste branch; criar recency.ts aqui colidiria no merge). Semântica VERBATIM
 * da canônica — manter paridade.
 * TODO(consolidar): quando recency.ts mergear, `import { clampRecencyCapDays } from './recency'`
 * e remover esta cópia.
 */
export function clampRecencyCapDays(raw: unknown): number {
  if (raw == null) return DEFAULT_RECENCY_CAP_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_RECENCY_CAP_DAYS;
  return Math.min(MAX_RECENCY_CAP_DAYS, Math.max(MIN_RECENCY_CAP_DAYS, Math.round(n)));
}
