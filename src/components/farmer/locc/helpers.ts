// Helpers e constantes de apresentação da tela FarmerLOCC.
// Extraídos verbatim de src/pages/FarmerLOCC.tsx (god-component split).

export const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const fmtDur = (s: number) => {
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60) > 0 ? ` ${Math.round(s % 60)}s` : ''}`;
};

export const healthColors: Record<string, { bg: string; text: string }> = {
  saudavel: { bg: 'bg-status-success-bg', text: 'text-status-success' },
  estavel: { bg: 'bg-status-info-bg', text: 'text-status-info' },
  atencao: { bg: 'bg-status-warning-bg', text: 'text-status-warning' },
  critico: { bg: 'bg-status-error-bg', text: 'text-status-error' },
};

export const metricLabels: Record<string, string> = {
  margem_por_hora: 'Margem/Hora',
  ltv: 'LTV',
  churn: 'Churn (%)',
  receita_incremental: 'Receita Incremental',
};

export const statusColors: Record<string, string> = {
  rascunho: 'bg-muted text-muted-foreground',
  ativo: 'bg-status-info-bg text-status-info-fg',
  concluido: 'bg-status-success-bg text-status-success-fg',
  cancelado: 'bg-status-error-bg text-status-error-fg',
};
