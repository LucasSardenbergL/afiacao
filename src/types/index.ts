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

// Tool categories
export type ToolCategory = 
  | 'facas_cozinha'
  | 'tesouras'
  | 'alicates'
  | 'formoes'
  | 'plainas'
  | 'brocas'
  | 'serras'
  | 'laminas_serra'
  | 'laminas_industriais'
  | 'ferramentas_marcenaria'
  | 'ferramentas_jardinagem'
  | 'outro';

export const TOOL_CATEGORIES: Record<ToolCategory, string> = {
  facas_cozinha: 'Facas de Cozinha/Chef',
  tesouras: 'Tesouras',
  alicates: 'Alicates',
  formoes: 'Formões',
  plainas: 'Plainas',
  brocas: 'Brocas',
  serras: 'Serras',
  laminas_serra: 'Lâminas de Serra',
  laminas_industriais: 'Lâminas Industriais',
  ferramentas_marcenaria: 'Ferramentas de Marcenaria',
  ferramentas_jardinagem: 'Ferramentas de Jardinagem',
  outro: 'Outro',
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

// Usage type (industrial vs domestic)
export type UsageType = 'industrial' | 'domestico';

export const USAGE_TYPES: Record<UsageType, { label: string; description: string }> = {
  domestico: { label: 'Uso Doméstico', description: 'Ferramentas de uso doméstico/residencial' },
  industrial: { label: 'Uso Industrial', description: 'Ferramentas de uso profissional/industrial' },
};

// Delivery options
export type DeliveryOption = 'coleta_entrega' | 'somente_coleta' | 'somente_entrega' | 'balcao';

export const DELIVERY_OPTIONS: Record<DeliveryOption, { label: string; description: string }> = {
  coleta_entrega: { label: 'Coleta e Entrega em Casa', description: 'Buscamos e entregamos no seu endereço' },
  somente_coleta: { label: 'Somente Coleta', description: 'Buscamos em casa, você retira no balcão' },
  somente_entrega: { label: 'Somente Entrega', description: 'Você traz ao balcão, entregamos em casa' },
  balcao: { label: 'Levar e Retirar no Balcão', description: 'Você traz e retira na nossa loja' },
};

// Delivery fees by usage type
export const DELIVERY_FEES: Record<UsageType, Record<DeliveryOption, number>> = {
  domestico: {
    coleta_entrega: 15,
    somente_coleta: 10,
    somente_entrega: 10,
    balcao: 0,
  },
  industrial: {
    coleta_entrega: 0,
    somente_coleta: 0,
    somente_entrega: 0,
    balcao: 0,
  },
};

// Time slots
export const TIME_SLOTS = [
  { id: '08-12', label: '08:00 - 12:00' },
  { id: '12-16', label: '12:00 - 16:00' },
  { id: '16-20', label: '16:00 - 20:00' },
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
  usageType?: UsageType;
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
