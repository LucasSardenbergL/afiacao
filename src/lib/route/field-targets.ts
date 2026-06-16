// Helpers puros do contexto "Visitas em campo" (hunter) do Roteirizador.
// Eixo de CONTEXTO ('campo' | 'equipe') acima do eixo de MODO existente.
// O contexto "campo" reusa internamente planningMode='prospeccao'.
import type { PlanningContext, PlanningMode, RouteStop, TargetFilter } from '@/components/reposicao/routePlanner/types';

/** Contexto inicial por papel: master entra na caça (campo); o resto, na equipe. */
export function defaultContextForRole(isMaster: boolean): PlanningContext {
  return isMaster ? 'campo' : 'equipe';
}

/**
 * Modo de planejamento resultante ao trocar de contexto.
 * - campo → sempre 'prospeccao' (a infra de prospects+carteira).
 * - equipe → se vinha de 'prospeccao', cai no 'hibrido' (default operacional);
 *   senão preserva o modo de equipe já escolhido.
 */
export function nextModeForContext(ctx: PlanningContext, currentMode: PlanningMode): PlanningMode {
  if (ctx === 'campo') return 'prospeccao';
  return currentMode === 'prospeccao' ? 'hibrido' : currentMode;
}

/** Dedupe por `id`, preservando a primeira ocorrência (ordem estável). */
export function dedupeStopsById<T extends { id: string }>(stops: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of stops) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** Separa o universo de alvos em prospects (prospect_visit) e clientes (resto). */
export function particionarAlvos(stops: RouteStop[]): { clientes: RouteStop[]; prospects: RouteStop[] } {
  const clientes: RouteStop[] = [];
  const prospects: RouteStop[] = [];
  for (const s of stops) {
    if (s.stopType === 'prospect_visit') prospects.push(s);
    else clientes.push(s);
  }
  return { clientes, prospects };
}

/** Filtra o universo de alvos por Todos/Clientes/Prospects. */
export function filtrarAlvos(stops: RouteStop[], filtro: TargetFilter): RouteStop[] {
  if (filtro === 'todos') return stops;
  if (filtro === 'prospects') return stops.filter((s) => s.stopType === 'prospect_visit');
  return stops.filter((s) => s.stopType !== 'prospect_visit');
}

/** Toggle imutável de um id no conjunto de alvos selecionados pra rota. */
export function toggleTarget(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** lower + remove acentos (busca tolerante: "moveis" acha "Móveis"). */
const semAcento = (t: string): string =>
  t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Critérios de filtro do universo de alvos (contexto campo). */
export interface FiltrosAlvo {
  /** Tipo: 'todos' | 'clientes' | 'prospects'. */
  tipo: TargetFilter;
  /** Busca por nome (ignora acento e caixa, substring). */
  busca: string;
  /** Só alvos com telefone. */
  comTelefone: boolean;
  /** prospeccao_status incluídos (vazio = todos). Só afeta prospects. */
  status: string[];
  /** Bairro exato (null = todos). */
  bairro: string | null;
}

export const FILTROS_ALVO_INICIAL: FiltrosAlvo = {
  tipo: 'todos',
  busca: '',
  comTelefone: false,
  status: [],
  bairro: null,
};

/** Aplica todos os critérios (AND) sobre o universo de alvos. Puro. */
export function aplicarFiltrosAlvos(stops: RouteStop[], f: FiltrosAlvo): RouteStop[] {
  let out = filtrarAlvos(stops, f.tipo);
  const q = semAcento(f.busca.trim());
  if (q) out = out.filter((s) => semAcento(s.customerName).includes(q));
  if (f.comTelefone) out = out.filter((s) => !!s.phone && s.phone.trim() !== '');
  if (f.status.length > 0) {
    out = out.filter((s) => s.prospeccaoStatus != null && f.status.includes(s.prospeccaoStatus));
  }
  if (f.bairro != null) {
    out = out.filter((s) => s.address.neighborhood === f.bairro);
  }
  return out;
}

/** Bairros distintos presentes no universo (ordenados pt-BR, sem vazios). Puro. */
export function bairrosDe(stops: RouteStop[]): string[] {
  const set = new Set<string>();
  for (const s of stops) {
    const b = s.address.neighborhood?.trim();
    if (b) set.add(b);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}
