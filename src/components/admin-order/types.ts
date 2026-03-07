import { Package, Clock, Truck, CheckCircle, Building2 } from 'lucide-react';

export const EMPLOYEE_ORDER_STATUS = {
  pedido_recebido: { label: 'Pedido Recebido', icon: Package, color: 'bg-blue-500' },
  aguardando_coleta: { label: 'Aguardando Coleta', icon: Clock, color: 'bg-amber-500' },
  em_triagem: { label: 'Coletado e na Empresa', icon: Building2, color: 'bg-purple-500' },
  em_rota: { label: 'A Caminho da Entrega', icon: Truck, color: 'bg-amber-500' },
  entregue: { label: 'Entregue', icon: CheckCircle, color: 'bg-emerald-500' },
} as const;

export interface OrderItem {
  category: string;
  quantity: number;
  omie_codigo_servico?: number;
  brandModel?: string;
  notes?: string;
  photos?: string[];
  userToolId?: string;
  unitPrice?: number;
  toolCategoryId?: string;
  toolSpecs?: Record<string, string>;
}

export interface Order {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  items: OrderItem[];
  total: number;
  subtotal: number;
  delivery_fee: number;
  delivery_option: string;
  user_id: string;
  notes: string | null;
}

export interface Profile {
  name: string;
  document: string | null;
  phone: string | null;
}
