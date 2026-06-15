// Helper puro do Roteirizador-campo (Sub-PR 2): mapeia uma linha da RPC
// carteira_por_municipio para um "draft" de parada (cliente da carteira), sem os
// campos de priority (o client aplica enrichWithPriority). Espelha o Returns da
// RPC (todos os campos podem vir null na prática — o gerador do Supabase não
// marca nullability de RETURNS TABLE). Captura `dias_desde_visita` (recência)
// pro Sub-PR 4 (cores do mapa).

export interface CarteiraRow {
  user_id: string;
  name: string | null;
  phone: string | null;
  street: string | null;
  number: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  complement: string | null;
  business_hours_open: string | null;
  business_hours_close: string | null;
  ultima_visita: string | null;
  dias_desde_visita: number | null;
}

export interface CarteiraStopDraft {
  id: string;
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
  visitReason: string;
  businessHoursOpen: string | null;
  businessHoursClose: string | null;
  diasDesdeVisita: number | null;
}

const s = (v: string | null | undefined): string => (v ?? '').trim();

export function carteiraRowToStop(row: CarteiraRow, cityNome: string): CarteiraStopDraft {
  return {
    id: `carteira-cidade-${row.user_id}`,
    customerUserId: row.user_id,
    customerName: s(row.name) || 'Cliente',
    phone: s(row.phone) || null,
    address: {
      street: s(row.street),
      number: s(row.number),
      neighborhood: s(row.neighborhood),
      city: s(row.city),
      state: s(row.state),
      zip_code: s(row.zip_code),
      complement: s(row.complement) || undefined,
    },
    visitReason: `Cliente em ${cityNome}`,
    businessHoursOpen: s(row.business_hours_open) || null,
    businessHoursClose: s(row.business_hours_close) || null,
    diasDesdeVisita: row.dias_desde_visita,
  };
}
