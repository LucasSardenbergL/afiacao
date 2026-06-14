// Types do planejador de rotas (AdminRoutePlanner).
// Extraídos de src/pages/AdminRoutePlanner.tsx (god-component split).

export type StopType =
  | 'pickup_tools'
  | 'deliver_tools'
  | 'sales_visit'
  | 'hybrid_visit'
  | 'manual_visit'
  | 'scheduled_visit'
  | 'prospect_visit';
export type PlanningMode = 'logistica' | 'comercial' | 'hibrido' | 'manual' | 'prospeccao';
/** Contexto de uso da tela: "campo" (hunter) vs "equipe" (operacional). */
export type PlanningContext = 'campo' | 'equipe';
/** Filtro do universo de alvos no contexto campo. */
export type TargetFilter = 'todos' | 'clientes' | 'prospects';
export type FilterPeriod = 'all' | 'manha' | 'tarde';
export type ManualFilter = 'todos' | 'nunca_visitados' | 'sem_compra_30d';

export interface ManualCustomer {
  user_id: string;
  name: string;
  phone: string | null;
  city: string;
  neighborhood: string;
  hasAddress: boolean;
  address: {
    street: string;
    number: string;
    neighborhood: string;
    city: string;
    state: string;
    zip_code: string;
    complement?: string;
  };
  lastVisitDate: string | null;
  lastOrderDate: string | null;
  daysSinceLastVisit: number | null;
  daysSinceLastOrder: number | null;
}

export interface VisitStatus {
  stopId: string;
  visitId: string | null;
  checkInAt: string | null;
  isCheckedIn: boolean;
}

export interface RouteStop {
  id: string;
  stopType: StopType;
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
  timeSlot: string | null;
  businessHoursOpen: string | null;
  businessHoursClose: string | null;
  status: string;
  visitReason: string;
  orderId?: string;
  lat?: number;
  lng?: number;
  total?: number;
  priorityScore: number;
  priorityLabel: 'alta' | 'media' | 'baixa';
  priorityFactors: string[];
  // Campos exclusivos de paradas de prospecção (prospect_visit)
  radarCnpj?: string;
  geocodeFailed?: boolean;
  prospeccaoStatus?: string;
}

/** Cidade retornada por radar_contagem_por_municipio, usada no CitySelector. */
export interface CityOption {
  codigo: string;
  nome: string;
  uf: string;
  total: number;
  comTelefone: number;
  aContatar: number;
}
