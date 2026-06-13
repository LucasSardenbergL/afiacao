// Helper puro do Roteirizador-prospects (sub-PR A): mapeia uma linha de
// radar_prospects_para_rota (RPC) para um "draft" de parada do Roteirizador — sem
// os campos de priority (o client aplica enrichWithPriority) e sem acoplar ao tipo
// RouteStop estendido (que muda no sub-PR B). Também monta a query do Nominatim.
//
// Regra de geo: a RPC só devolve lat/lng quando geocode_status='ok'. O draft só
// adota lat/lng se status='ok' E ambos não-null (defensivo); 'falhou' vira a flag
// geocodeFailed (o client pula o re-geocode); status NULL = nunca tentado (geocodifica).

export interface ProspectRow {
  cnpj: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  municipio_nome: string | null;
  uf: string | null;
  cep: string | null;
  telefone1: string | null;
  telefone2: string | null;
  prospeccao_status: string;
  lat: number | null;
  lng: number | null;
  geocode_status: string | null;
}

export interface ProspectAddress {
  street: string;
  number: string;
  neighborhood: string;
  city: string;
  state: string;
  zip_code: string;
  complement?: string;
}

export interface ProspectStopDraft {
  id: string;
  radarCnpj: string;
  customerName: string;
  phone: string | null;
  address: ProspectAddress;
  visitReason: string;
  prospeccaoStatus: string;
  lat?: number;
  lng?: number;
  geocodeFailed?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  a_contatar: 'a contatar',
  contatado_sem_resposta: 'sem resposta',
  em_conversa: 'em conversa',
};

export function labelProspeccaoStatus(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

const s = (v: string | null | undefined): string => (v ?? '').trim();

export function prospectRowToStopDraft(row: ProspectRow): ProspectStopDraft {
  const nome = s(row.nome_fantasia) || s(row.razao_social) || row.cnpj;
  const phone = s(row.telefone1) || s(row.telefone2) || null;
  const temGeo = row.geocode_status === 'ok' && row.lat != null && row.lng != null;
  const falhou = row.geocode_status === 'falhou';
  const reasonSuffix =
    row.prospeccao_status === 'a_contatar' ? '' : ` · ${labelProspeccaoStatus(row.prospeccao_status)}`;
  return {
    id: `prospect-${row.cnpj}`,
    radarCnpj: row.cnpj,
    customerName: nome,
    phone,
    address: {
      street: s(row.logradouro),
      number: s(row.numero),
      neighborhood: s(row.bairro),
      city: s(row.municipio_nome),
      state: s(row.uf),
      zip_code: s(row.cep),
      complement: s(row.complemento) || undefined,
    },
    visitReason: `Prospecção${reasonSuffix}`,
    prospeccaoStatus: row.prospeccao_status,
    ...(temGeo ? { lat: row.lat as number, lng: row.lng as number } : {}),
    ...(falhou ? { geocodeFailed: true } : {}),
  };
}

// Query do Nominatim a partir do endereço (filtra partes vazias; sempre termina em
// "Brazil"). Extraída do inline do useRoutePlanner para o sub-PR B reusar e testar.
export function buildGeocodeQuery(a: {
  street?: string;
  number?: string;
  city?: string;
  state?: string;
}): string {
  const parts = [s(a.street), s(a.number), s(a.city), s(a.state)].filter(Boolean);
  return [...parts, 'Brazil'].join(', ');
}
