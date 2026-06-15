// Aparência dos pinos do mapa (Sub-PR 4, ponto E). PURO/testável — sem Leaflet/DOM.
// Cor codifica UMA dimensão (urgência de agir); forma codifica o tipo (§4 do design).
// markerVisual devolve só o TOM semântico; o render mapeia tom→hsl(var(--status-X)).
import type { RouteStop } from '@/components/reposicao/routePlanner/types';

export type MarkerTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
export type MarkerShape = 'circle' | 'diamond';
export interface MarkerVisual {
  tone: MarkerTone;
  shape: MarkerShape;
}

export type RecenciaFaixa = 'recente' | 'media' | 'antiga' | 'nunca';

/** Faixa de recência da carteira. Limites 30/90; null/undefined = nunca visitado. */
export function recenciaFaixa(dias: number | null | undefined): RecenciaFaixa {
  if (dias == null) return 'nunca';
  if (dias <= 30) return 'recente';
  if (dias <= 90) return 'media';
  return 'antiga';
}

const FAIXA_TONE: Record<RecenciaFaixa, MarkerTone> = {
  recente: 'success',
  media: 'warning',
  antiga: 'error',
  nunca: 'neutral',
};

function prospectTone(status: string | null | undefined): MarkerTone {
  switch ((status ?? '').trim()) {
    case 'a_contatar':
      return 'info';
    case 'contatado_sem_resposta':
      return 'warning';
    case 'em_conversa':
      return 'error';
    default:
      return 'neutral'; // desconhecido/inválido = cinza (§4)
  }
}

/** Tom + forma do pino. Forma = tipo (prospect→losango, carteira→círculo);
 *  tom = urgência (status do prospect / recência da carteira). Para o universo
 *  CAMPO (carteira `sales_visit` + prospect `prospect_visit`). */
export function markerVisual(
  stop: Pick<RouteStop, 'stopType' | 'diasDesdeVisita' | 'prospeccaoStatus'>,
): MarkerVisual {
  if (stop.stopType === 'prospect_visit') {
    return { tone: prospectTone(stop.prospeccaoStatus), shape: 'diamond' };
  }
  return { tone: FAIXA_TONE[recenciaFaixa(stop.diasDesdeVisita)], shape: 'circle' };
}

/** tom→cor CSS (resolve contra os tokens --status-* vivos → adapta a dark). */
export const TONE_CSS: Record<MarkerTone, string> = {
  success: 'hsl(var(--status-success))',
  warning: 'hsl(var(--status-warning))',
  error: 'hsl(var(--status-error))',
  info: 'hsl(var(--status-info))',
  neutral: 'hsl(var(--muted-foreground))',
};

/** Maior→menor urgência (a borda do cluster pega o 1º tom presente). Interno. */
const URGENCIA_ORDEM: MarkerTone[] = ['error', 'warning', 'info', 'success', 'neutral'];

export interface ClusterStats {
  total: number;
  porTone: Record<MarkerTone, number>;
  maiorUrgencia: MarkerTone; // borda do cluster
  vermelhos: number; // badge !N
}

/** Agrega um cluster SEM cor-média: total, maior-urgência presente, nº de vermelhos. */
export function clusterStats(
  stops: Array<Pick<RouteStop, 'stopType' | 'diasDesdeVisita' | 'prospeccaoStatus'>>,
): ClusterStats {
  const porTone: Record<MarkerTone, number> = {
    success: 0,
    warning: 0,
    error: 0,
    info: 0,
    neutral: 0,
  };
  for (const s of stops) porTone[markerVisual(s).tone]++;
  const maiorUrgencia = URGENCIA_ORDEM.find((t) => porTone[t] > 0) ?? 'neutral';
  return { total: stops.length, porTone, maiorUrgencia, vermelhos: porTone.error };
}
