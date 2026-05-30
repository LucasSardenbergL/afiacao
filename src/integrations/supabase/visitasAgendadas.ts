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

export interface NovaVisitaAgendada {
  customer_user_id: string;
  scheduled_by: string;
  scheduled_date: string;
  notes?: string | null;
  visit_type?: string;
}

/**
 * Acesso à tabela `visitas_agendadas` antes dela existir nos tipos gerados do
 * Supabase. Único ponto com cast (via `unknown`, nunca `any`). Depois do regen
 * de tipos via Lovable, trocar por `supabase.from('visitas_agendadas')` direto.
 *
 * Forma (a): cast do supabase para objeto com `from(table: string)` retornando
 * o tipo que o próprio `from` nativo retorna quando chamado com string genérica.
 */
export function visitasAgendadasTable() {
  return (supabase as unknown as {
    from: (table: string) => ReturnType<typeof supabase.from>;
  }).from('visitas_agendadas');
}
