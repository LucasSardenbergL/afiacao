import type { AgendaItem, ClientScore } from '@/hooks/useFarmerScoring';
import type { CarteiraSlaRow, HealthClass } from '@/hooks/useCarteiraSla';

export type AgendaTipo = 'risco' | 'expansao' | 'follow_up';

const AGENDA_TIPOS: { tipo: AgendaTipo; label: string; tom: string }[] = [
  { tipo: 'risco', label: 'Risco', tom: 'text-status-error' },
  { tipo: 'expansao', label: 'Expansão', tom: 'text-status-success' },
  { tipo: 'follow_up', label: 'Follow-up', tom: 'text-status-info' },
];

export function healthBadge(h: HealthClass): { label: string; className: string } {
  const map: Record<HealthClass, { label: string; className: string }> = {
    saudavel: { label: 'Saudável', className: 'text-status-success' },
    estavel: { label: 'Estável', className: 'text-status-info' },
    atencao: { label: 'Atenção', className: 'text-status-warning' },
    critico: { label: 'Crítico', className: 'text-status-error' },
  };
  return map[h] ?? { label: String(h), className: 'text-muted-foreground' };
}

export interface CardCarteiraVM {
  customer_user_id: string;
  nome: string;
  agendaType: AgendaTipo;
  healthClass: HealthClass;
  churnRisk: number | null;
  phone: string | null;
  slaVencido: boolean;
  diasSemContato: number | null;
  priorityScore: number;
}

export interface ColunaBoard {
  tipo: AgendaTipo;
  label: string;
  tom: string;
  cards: CardCarteiraVM[];
}

/**
 * Cruza a agenda (useFarmerScoring) com os scores (nome/phone/churn) e a fila de
 * SLA (useCarteiraSla) por customer_user_id, e agrupa nas 3 colunas por agendaType.
 * Helper PURO — sem efeitos, testável isolado.
 */
export function montarColunasBoard(
  agenda: AgendaItem[],
  clientScores: ClientScore[],
  slaRows: CarteiraSlaRow[],
): ColunaBoard[] {
  const scoreById = new Map(clientScores.map((c) => [c.customer_user_id, c]));
  const slaById = new Map(slaRows.map((r) => [r.customer_user_id, r]));

  const cards: CardCarteiraVM[] = agenda.map((a) => {
    const sc = scoreById.get(a.customer_user_id);
    const sla = slaById.get(a.customer_user_id);
    return {
      customer_user_id: a.customer_user_id,
      nome: a.customer_name,
      agendaType: a.agendaType,
      healthClass: sc?.healthClass ?? (a.healthClass as HealthClass),
      churnRisk: sc?.churnRisk ?? null,
      phone: sc?.customer_phone ?? null,
      slaVencido: sla?.vencido ?? false,
      diasSemContato: sla?.dias_sem_contato ?? null,
      priorityScore: a.priorityScore,
    };
  });

  return AGENDA_TIPOS.map(({ tipo, label, tom }) => ({
    tipo,
    label,
    tom,
    cards: cards.filter((c) => c.agendaType === tipo),
  }));
}
