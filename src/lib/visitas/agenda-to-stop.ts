// Helper puro: converte uma linha de visita agendada + dados resolvidos de perfil/endereço
// no input esperado por `enrichWithPriority` (sem os campos de prioridade).
// PURA — sem chamadas ao Supabase; testável de forma isolada.
import type { VisitaAgendadaRow } from '@/integrations/supabase/visitasAgendadas';

export interface AgendaStopProfile {
  name: string | null;
  phone: string | null;
  business_hours_open: string | null;
  business_hours_close: string | null;
}

export interface AgendaStopAddress {
  street: string;
  number: string;
  neighborhood: string;
  city: string;
  state: string;
  zip_code: string;
  complement: string | null;
}

export interface AgendaRouteStopInput {
  id: string;
  stopType: 'scheduled_visit';
  customerUserId: string;
  customerName: string;
  phone: string | null;
  address: {
    street: string;
    number: string;
    neighborhood: string;
    city: string;
    state: string;
    zip_code: string;
    complement?: string;
  };
  timeSlot: null;
  businessHoursOpen: string | null;
  businessHoursClose: string | null;
  status: 'scheduled';
  visitReason: string;
}

/**
 * Converte uma linha de `visitas_agendadas` + dados resolvidos de perfil/endereço
 * no formato de input do `enrichWithPriority`.
 *
 * - `id` = `scheduled-visit-{row.id}`
 * - `customerName` = nome do perfil ou 'Cliente'
 * - `address` = campos do endereço (strings vazias se addr ausente)
 * - `complement` = omitido do objeto quando ausente (undefined)
 * - `visitReason` = 'Agendada · {notes}' quando há notas; 'Visita agendada' quando não há
 */
export function agendaToRouteStop(
  row: VisitaAgendadaRow,
  profile: AgendaStopProfile | undefined,
  addr: AgendaStopAddress | undefined,
): AgendaRouteStopInput {
  return {
    id: `scheduled-visit-${row.id}`,
    stopType: 'scheduled_visit',
    customerUserId: row.customer_user_id,
    customerName: profile?.name ?? 'Cliente',
    phone: profile?.phone ?? null,
    address: {
      street: addr?.street ?? '',
      number: addr?.number ?? '',
      neighborhood: addr?.neighborhood ?? '',
      city: addr?.city ?? '',
      state: addr?.state ?? '',
      zip_code: addr?.zip_code ?? '',
      ...(addr?.complement ? { complement: addr.complement } : {}),
    },
    timeSlot: null,
    businessHoursOpen: profile?.business_hours_open ?? null,
    businessHoursClose: profile?.business_hours_close ?? null,
    status: 'scheduled',
    visitReason: row.notes ? `Agendada · ${row.notes}` : 'Visita agendada',
  };
}
