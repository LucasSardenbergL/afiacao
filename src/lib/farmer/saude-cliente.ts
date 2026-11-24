// Dicionário ÚNICO de rótulos e cores da saúde do cliente (`farmer_client_scores.health_class`).
// Usado pela lista (/admin/customers) e pela 360 — antes eram dois mapas, e o da 360 não tinha
// `estavel`: 235 clientes "Estável" apareciam como "Sem score" (onda B).
//
// Vocabulário = o que a edge `calculate-scores` grava. Medido em prod (2026-11-24):
// saudavel · estavel · atencao · critico (nenhum outro valor). Valor desconhecido NÃO herda cor
// de nenhuma classe: vira "Não avaliado", neutro.

export const CLASSES_SAUDE = ['saudavel', 'estavel', 'atencao', 'critico'] as const;
export type ClasseSaude = (typeof CLASSES_SAUDE)[number];

export interface TomSaude {
  label: string;
  /** Cor do texto solto (token `text-status-*`). */
  texto: string;
  /** Bolinha indicadora. */
  ponto: string;
  /** Chip/badge: fundo + texto + borda, todos tokens de status. */
  chip: string;
}

export const SAUDE_CLIENTE: Record<ClasseSaude, TomSaude> = {
  saudavel: {
    label: 'Saudável',
    texto: 'text-status-success-bold',
    ponto: 'bg-status-success',
    chip: 'bg-status-success-bg text-status-success-bold border-status-success/20',
  },
  estavel: {
    label: 'Estável',
    texto: 'text-status-info-bold',
    ponto: 'bg-status-info',
    chip: 'bg-status-info-bg text-status-info-bold border-status-info/20',
  },
  atencao: {
    label: 'Atenção',
    texto: 'text-status-warning-bold',
    ponto: 'bg-status-warning',
    chip: 'bg-status-warning-bg text-status-warning-bold border-status-warning/20',
  },
  critico: {
    label: 'Crítico',
    texto: 'text-status-error-bold',
    ponto: 'bg-status-error',
    chip: 'bg-status-error-bg text-status-error-bold border-status-error/20',
  },
};

const NEUTRO = {
  texto: 'text-muted-foreground',
  ponto: 'bg-muted-foreground',
  chip: 'bg-muted text-muted-foreground border-border',
};

export const TOM_SEM_HISTORICO: TomSaude = { label: 'Sem histórico', ...NEUTRO };
export const TOM_NAO_AVALIADO: TomSaude = { label: 'Não avaliado', ...NEUTRO };

export function ehClasseSaude(v: string | null | undefined): v is ClasseSaude {
  return (CLASSES_SAUDE as readonly string[]).includes(v ?? '');
}

/**
 * O que a tela pode afirmar da saúde. `sem_historico` vence a classe (a edge grava "critico" para
 * quem nunca comprou — não é medida). Classe ausente/desconhecida → "Não avaliado", nunca uma cor
 * emprestada.
 */
export function tomSaude(healthClass: string | null | undefined, salesHistoryStatus?: string | null): TomSaude {
  if (salesHistoryStatus === 'sem_historico') return TOM_SEM_HISTORICO;
  return ehClasseSaude(healthClass) ? SAUDE_CLIENTE[healthClass] : TOM_NAO_AVALIADO;
}
