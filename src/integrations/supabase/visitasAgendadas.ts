import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';

const STATUS_VISITA = ['pendente', 'realizada', 'cancelada'] as const;
type VisitaStatus = (typeof STATUS_VISITA)[number];

/**
 * Row de `visitas_agendadas`. Deriva do tipo gerado (`types.ts`) e estreita
 * `status` (coluna `text` com CHECK no banco) pro union de domínio — via
 * `visitaDaLinha`, que confere o vocabulário em vez de afirmá-lo.
 */
export type VisitaAgendadaRow = Omit<Tables<'visitas_agendadas'>, 'status'> & {
  status: VisitaStatus;
};

/** Builder tipado pra `visitas_agendadas` (tabela já presente no types.ts gerado). */
export function visitasAgendadasTable() {
  return supabase.from('visitas_agendadas');
}

/** Borda: `status` fora do CHECK de prod LANÇA (não vira rótulo inventado). */
export function visitaDaLinha(linha: Tables<'visitas_agendadas'>): VisitaAgendadaRow {
  const status = STATUS_VISITA.find((s) => s === linha.status);
  if (!status) throw new Error(`visitas_agendadas ${linha.id}: status fora do CHECK (${linha.status})`);
  return { ...linha, status };
}
