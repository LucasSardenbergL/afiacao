import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';

type VisitaStatus = 'pendente' | 'realizada' | 'cancelada';

/**
 * Row de `visitas_agendadas`. Deriva do tipo gerado (`types.ts`) e estreita
 * `status` (coluna `text` no banco) pro union de domínio. Os consumidores fazem
 * o cast estreito no boundary da query (`data as unknown as VisitaAgendadaRow[]`).
 */
export type VisitaAgendadaRow = Omit<Tables<'visitas_agendadas'>, 'status'> & {
  status: VisitaStatus;
};

/** Builder tipado pra `visitas_agendadas` (tabela já presente no types.ts gerado). */
export function visitasAgendadasTable() {
  return supabase.from('visitas_agendadas');
}
