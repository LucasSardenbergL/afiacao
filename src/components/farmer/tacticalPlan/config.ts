// Helpers e mapas de rótulos do FarmerTacticalPlan.
// Extraídos verbatim de src/pages/FarmerTacticalPlan.tsx (god-component split).

/**
 * Formata dinheiro. Aceita null/undefined de propósito: os campos numéricos do plano
 * tático são "não medido" quando a IA não apurou o valor (margem, LTV) — e um plano
 * PARCIALMENTE medido ({current_annual: 120000, projected_annual: null}) passa pelos
 * guards `plan.ltvProjection &&`, que só testam o objeto. Sem este null-check,
 * `null.toLocaleString()` derruba a tela inteira no ErrorBoundary quando a vendedora
 * expande o plano. "—" é a leitura honesta: não medido não é R$ 0,00.
 */
export const fmt = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const objectiveColors: Record<string, string> = {
  recuperacao: 'bg-status-error-bg text-status-error-fg',
  expansao_mix: 'bg-status-success-bg text-status-success-fg',
  upsell_premium: 'bg-status-info-bg text-status-info-fg',
  reativacao: 'bg-status-warning-bg text-status-warning-fg',
  consolidacao_margem: 'bg-orange-100 text-orange-800',
};

export const profileLabels: Record<string, string> = {
  sensivel_preco: '💰 Sensível a Preço',
  orientado_qualidade: '⭐ Orientado a Qualidade',
  orientado_produtividade: '⚡ Orientado a Produtividade',
  misto: '🔄 Perfil Misto',
};
