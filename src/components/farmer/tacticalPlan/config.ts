// Helpers e mapas de rótulos do FarmerTacticalPlan.
// Extraídos verbatim de src/pages/FarmerTacticalPlan.tsx (god-component split).

export const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

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
