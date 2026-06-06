// Tipos + constantes + helpers da listagem de pedidos de venda.
// Extraídos verbatim de src/pages/SalesOrders.tsx (god-component split).
import type { InfiniteData } from '@tanstack/react-query';
import type { Tables } from '@/integrations/supabase/types';

export type SalesOrderRow = Tables<'sales_orders'>;
export type AfiacaoOrderRow = Tables<'orders'>;
export type ProfileRow = Tables<'profiles'>;

// Shape de cada item dentro de orders.items (jsonb). Só os campos consumidos aqui.
export interface AfiacaoItemRaw {
  category?: string | null;
  name?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
}

// 3 empresas reais (oben, colacor, colacor_sc) + 'all'. Afiação NÃO é empresa,
// é um módulo operando sob Colacor SC — pedidos da tabela `orders` (afiação)
// aparecem dentro da aba "Colacor SC" junto com os pedidos comerciais
// `sales_orders WHERE account='colacor_sc'`. Cada card mantém badge "Afiação"
// quando _source='afiacao' pra preservar a distinção visual.
export type Account = 'oben' | 'colacor' | 'colacor_sc' | 'all';

export const PAGE_SIZE = 50;

export const decodeHtml = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

export interface SalesOrder {
  id: string;
  customer_user_id: string;
  items: Array<{ descricao: string; quantidade: number; valor_unitario: number; valor_total: number }>;
  subtotal: number;
  total: number;
  status: string;
  omie_numero_pedido: string | null;
  omie_pedido_id: number | null;
  created_at: string;
  notes: string | null;
  account?: string;
  _source?: 'sales' | 'afiacao';
  // Campos que o select('*') de sales_orders já traz em runtime — consumidos
  // pela impressão do pedido (buildSalesOrderPrintRow). Opcionais: os pedidos
  // de afiação (montados à mão no hook) não os têm.
  customer_address?: string | null;
  customer_phone?: string | null;
  omie_payload?: unknown;
  discount?: number;
}

// Cache do useInfiniteQuery de sales_orders — usado nos rollbacks optimistic.
export type SalesOrdersInfiniteCache = InfiniteData<SalesOrder[]>;

export const statusLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  rascunho: { label: 'Rascunho', variant: 'outline' },
  enviado: { label: 'Enviado ao Omie', variant: 'default' },
  faturado: { label: 'Faturado', variant: 'secondary' },
  cancelado: { label: 'Cancelado', variant: 'destructive' },
  recebido: { label: 'Recebido', variant: 'default' },
  em_analise: { label: 'Em Análise', variant: 'default' },
  em_producao: { label: 'Em Produção', variant: 'default' },
  pronto: { label: 'Pronto', variant: 'secondary' },
  entregue: { label: 'Entregue', variant: 'secondary' },
};
