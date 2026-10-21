// Tipos + constantes + helpers da listagem de pedidos de venda.
// Extraídos verbatim de src/pages/SalesOrders.tsx (god-component split).
import type { Tables } from '@/integrations/supabase/types';

export type SalesOrderRow = Tables<'sales_orders'>;
export type AfiacaoOrderRow = Tables<'orders'>;

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

export const decodeHtml = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

// Item do pedido como o painel/impressão o leem do jsonb sales_orders.items (`itemDetalheDoJson`).
// Os campos extras (codigo/unidade/tint) só aparecem em alguns itens (ex.: bases tintométricas).
export type SalesOrderItem = {
  descricao: string;
  quantidade: number;
  /** `null` = preco NAO SABIDO (o Omie nao informou valor_unitario). Nunca R$ 0,00. */
  valor_unitario: number | null;
  /** Ausente na quase totalidade dos itens gravados (o total é derivado); `null` = sem preço, sem total. */
  valor_total?: number | null;
  codigo?: string;
  unidade?: string;
  tint_cor_id?: string;
  tint_nome_cor?: string;
};

export interface SalesOrder {
  id: string;
  customer_user_id: string;
  items: SalesOrderItem[];
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

// Linha da view order_feed (read model da listagem — migration 20260606210000).
type LinhaOrderFeed = Tables<'order_feed'>;

/** Colunas sem as quais a linha do feed não faz sentido (view: o gerador as dá todas `| null`). */
export const COLUNAS_FEED_EXIGIDAS = [
  'origin', 'id', 'created_at', 'account', 'customer_user_id',
  'item_names', 'item_quantity', 'status', 'subtotal', 'total',
] as const satisfies readonly (keyof LinhaOrderFeed)[];

/** Linha da view `order_feed` com as colunas-chave exigidas e `origin` estreitado (`feedRowDaLinha`). */
export type OrderFeedRow = Omit<LinhaOrderFeed, (typeof COLUNAS_FEED_EXIGIDAS)[number]> & {
  [K in Exclude<(typeof COLUNAS_FEED_EXIGIDAS)[number], 'origin'>]: NonNullable<LinhaOrderFeed[K]>;
} & { origin: 'sales' | 'afiacao' };

// Cache da query única da listagem (['order-feed', userId]) — rollbacks optimistic.
export interface OrderFeedCache {
  rows: OrderFeedRow[];
  count: number;
}

// Detalhe completo de um pedido, buscado por (origin, id) ao abrir o painel /
// imprimir / compartilhar. A listagem (view) é enxuta de propósito.
export interface OrderDetail {
  order: SalesOrder;
  customerName: string;
  customerDocument?: string;
}

export const statusLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  rascunho: { label: 'Rascunho', variant: 'outline' },
  enviado: { label: 'Enviado ao Omie', variant: 'default' },
  // Status gravados pelo omie-vendas-sync (pedido criado direto no Omie ou
  // registro paralelo do sync) — sem entrada aqui caíam no fallback "Rascunho".
  importado: { label: 'Importado', variant: 'secondary' },
  separacao: { label: 'Em separação', variant: 'default' },
  faturado: { label: 'Faturado', variant: 'secondary' },
  cancelado: { label: 'Cancelado', variant: 'destructive' },
  recebido: { label: 'Recebido', variant: 'default' },
  em_analise: { label: 'Em Análise', variant: 'default' },
  em_producao: { label: 'Em Produção', variant: 'default' },
  pronto: { label: 'Pronto', variant: 'secondary' },
  entregue: { label: 'Entregue', variant: 'secondary' },
};

// Lookup com fallback HONESTO: status desconhecido exibe o próprio status
// (capitalizado, "_" → espaço), nunca finge ser "Rascunho" — um pedido já no
// Omie rotulado de rascunho induz a vendedora a erro.
export function statusDoPedido(status: string): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  const conhecido = statusLabels[status];
  if (conhecido) return conhecido;
  const cru = (status || '').replace(/_/g, ' ').trim();
  return {
    label: cru ? cru.charAt(0).toUpperCase() + cru.slice(1) : 'Sem status',
    variant: 'outline',
  };
}
