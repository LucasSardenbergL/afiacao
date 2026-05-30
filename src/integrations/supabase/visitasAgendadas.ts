import { supabase } from '@/integrations/supabase/client';

export type VisitaStatus = 'pendente' | 'realizada' | 'cancelada';

export interface VisitaAgendadaRow {
  id: string;
  customer_user_id: string;
  scheduled_by: string;
  scheduled_date: string;   // 'YYYY-MM-DD'
  status: VisitaStatus;
  visit_type: string;
  notes: string | null;
  route_visit_id: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Builder estreito — `visitas_agendadas` ainda não está no types.ts gerado.
// Declarar só os métodos usados evita a instanciação "excessively deep" (TS2589)
// do builder genérico do Supabase. Este é o ÚNICO ponto de cast (via unknown,
// nunca any). Pós type-regen via Lovable: trocar por supabase.from('visitas_agendadas').
// ---------------------------------------------------------------------------
type DbError = { code?: string; message: string } | null;
type DbResult<T = unknown> = Promise<{ data: T; error: DbError }>;

export interface VisitaInsert {
  customer_user_id: string;
  scheduled_by: string;
  scheduled_date: string;
  notes: string | null;
  visit_type: string;
  status: string;
}

export interface VisitaUpdate {
  scheduled_date?: string;
  status?: string;
}

export interface VisitaFilter {
  select: (cols: string) => VisitaFilter;
  insert: (row: VisitaInsert) => DbResult;
  update: (patch: VisitaUpdate) => VisitaFilter;
  eq: (col: string, val: string) => VisitaFilter;
  in: (col: string, vals: string[]) => VisitaFilter;
  order: (col: string, opts: { ascending: boolean }) => VisitaFilter;
  then: <T>(
    onFulfilled: (value: { data: unknown; error: DbError }) => T,
  ) => Promise<T>;
}

type VisitasClient = { from: (table: 'visitas_agendadas') => VisitaFilter };

/**
 * Builder tipado e estreito para a tabela `visitas_agendadas`. Único ponto de cast.
 */
export function visitasAgendadasTable(): VisitaFilter {
  return (supabase as unknown as VisitasClient).from('visitas_agendadas');
}
