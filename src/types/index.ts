// User types
export interface User {
  id: string;
  name: string;
  email?: string;
  phone: string;
  cpfCnpj?: string;
  whatsapp: string;
  role: 'client' | 'admin' | 'operator';
  createdAt: Date;
}

export interface Address {
  id: string;
  userId: string;
  label: string;
  street: string;
  number: string;
  complement?: string;
  neighborhood: string;
  city: string;
  state: string;
  zipCode: string;
  isDefault: boolean;
}

// Tool categories - Marcenaria (Woodworking)
export type ToolCategory = 
  | 'tesoura_profissional'
  | 'faca_plaina_estreita'
  | 'cabecote_desintegrador'
  | 'faca_desengrosso'
  | 'faca_plaina_manual'
  | 'fresa'
  | 'serra_circular_widea'
  | 'serra_circular_hss';

export const TOOL_CATEGORIES: Record<ToolCategory, string> = {
  tesoura_profissional: 'Tesoura Profissional',
  faca_plaina_estreita: 'Faca de Plaina (Estreita)',
  cabecote_desintegrador: 'Cabeçote Desintegrador',
  faca_desengrosso: 'Faca de Desengrosso',
  faca_plaina_manual: 'Faca de Plaina Manual',
  fresa: 'Fresa',
  serra_circular_widea: 'Serra Circular de Widea',
  serra_circular_hss: 'Serra Circular de HSS',
};

// Service types
export type ServiceType = 'padrao' | 'premium' | 'recuperacao' | 'polimento';

export const SERVICE_TYPES: Record<ServiceType, { label: string; description: string }> = {
  padrao: { label: 'Afiação Padrão', description: 'Afiação básica para uso diário' },
  premium: { label: 'Afiação Premium', description: 'Afiação de alta precisão com acabamento superior' },
  recuperacao: { label: 'Recuperação/Restauração', description: 'Para ferramentas danificadas ou muito desgastadas' },
  polimento: { label: 'Polimento/Acabamento', description: 'Finalização estética e proteção' },
};

// Wear levels
export type WearLevel = 'leve' | 'medio' | 'pesado';

export const WEAR_LEVELS: Record<WearLevel, { label: string; color: string }> = {
  leve: { label: 'Leve', color: 'status-success' },
  medio: { label: 'Médio', color: 'status-pending' },
  pesado: { label: 'Pesado', color: 'status-danger' },
};

// Delivery options
export type DeliveryOption = 'coleta_entrega' | 'somente_coleta' | 'somente_entrega' | 'balcao';

export const DELIVERY_OPTIONS: Record<DeliveryOption, { label: string; description: string }> = {
  coleta_entrega: { label: 'Coleta e Entrega no Endereço', description: 'Buscamos e entregamos no seu endereço' },
  somente_coleta: { label: 'Somente Coleta', description: 'Buscamos no endereço, você retira no balcão' },
  somente_entrega: { label: 'Somente Entrega', description: 'Você traz ao balcão, entregamos no endereço' },
  balcao: { label: 'Levar e Retirar no Balcão', description: 'Você traz e retira na nossa loja' },
};

// Delivery fees - Industrial clients get free shipping
export const DELIVERY_FEES: Record<DeliveryOption, number> = {
  coleta_entrega: 0,
  somente_coleta: 0,
  somente_entrega: 0,
  balcao: 0,
};

// Time slots
export const TIME_SLOTS = [
  { id: 'manha', label: 'Parte da Manhã' },
  { id: 'tarde', label: 'Parte da Tarde' },
];

// Order status
export type OrderStatus = 
  | 'pedido_recebido'
  | 'aguardando_coleta'
  | 'recebido_balcao'
  | 'em_triagem'
  | 'orcamento_enviado'
  | 'aprovado'
  | 'em_afiacao'
  | 'controle_qualidade'
  | 'pronto_entrega'
  | 'em_rota'
  | 'entregue';

export const ORDER_STATUS: Record<OrderStatus, { label: string; description: string; color: string }> = {
  pedido_recebido: { label: 'Pedido Recebido', description: 'Seu pedido foi registrado', color: 'bg-blue-500' },
  aguardando_coleta: { label: 'Aguardando Coleta', description: 'Aguardando motoboy buscar', color: 'bg-amber-500' },
  recebido_balcao: { label: 'Recebido no Balcão', description: 'Material entregue na loja', color: 'bg-blue-500' },
  em_triagem: { label: 'Em Triagem', description: 'Analisando suas ferramentas', color: 'bg-purple-500' },
  orcamento_enviado: { label: 'Orçamento Enviado', description: 'Aguardando sua aprovação', color: 'bg-amber-500' },
  aprovado: { label: 'Aprovado', description: 'Orçamento aprovado, aguardando pagamento', color: 'bg-emerald-500' },
  em_afiacao: { label: 'Em Afiação', description: 'Suas ferramentas estão sendo afiadas', color: 'bg-primary' },
  controle_qualidade: { label: 'Controle de Qualidade', description: 'Verificação final', color: 'bg-indigo-500' },
  pronto_entrega: { label: 'Pronto para Entrega/Retirada', description: 'Suas ferramentas estão prontas', color: 'bg-emerald-500' },
  em_rota: { label: 'Em Rota de Entrega', description: 'Motoboy a caminho', color: 'bg-amber-500' },
  entregue: { label: 'Entregue/Finalizado', description: 'Pedido concluído', color: 'bg-emerald-600' },
};

// Tool item in order
export interface ToolItem {
  id: string;
  category: ToolCategory;
  brandModel?: string;
  quantity: number;
  photos: string[];
  wearLevel?: WearLevel;
  notes?: string;
  serviceType?: ServiceType;
  unitPrice?: number;
}

// Order
export interface Order {
  id: string;
  orderNumber: string;
  userId: string;
  items: ToolItem[];
  status: OrderStatus;
  deliveryOption: DeliveryOption;
  addressId?: string;
  timeSlot?: string;
  scheduledDate?: Date;
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  paymentMethod?: 'pix' | 'card' | 'on_delivery';
  paymentStatus: 'pending' | 'paid' | 'failed';
  quoteApproved: boolean;
  estimatedDelivery?: Date;
  createdAt: Date;
  updatedAt: Date;
  statusHistory: StatusHistoryItem[];
}

export interface StatusHistoryItem {
  status: OrderStatus;
  timestamp: Date;
  note?: string;
  operator?: string;
}

// Review
export interface Review {
  id: string;
  orderId: string;
  userId: string;
  rating: number;
  comment?: string;
  createdAt: Date;
}
