// Tipos da tela de edição de pedido de venda.
// Extraídos verbatim de src/pages/SalesOrderEdit.tsx (god-component split).

export interface OrderItem {
  product_id?: string;
  omie_codigo_produto: number;
  codigo?: string;
  descricao: string;
  unidade?: string;
  quantidade: number;
  valor_unitario: number;
  valor_total: number;
  tint_cor_id?: string;
  tint_nome_cor?: string;
  tint_formula_id?: string;
  // Fase 3: metadados de precificação (fonte escolhida + desconto declarado).
  // Editar o valor_unitario de um item tint MANUALMENTE os limpa (o item vira
  // "legado" e o gate da fronteira valida pelo piso min(fontes atuais)).
  tint_price_source?: string;
  tint_discount_pct?: number;
  tint_preco_sem_desconto?: number;
}

export interface OmiePayload {
  cabecalho?: {
    codigo_parcela?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SalesOrder {
  id: string;
  customer_user_id: string;
  items: OrderItem[];
  subtotal: number;
  total: number;
  status: string;
  notes: string | null;
  account: string;
  omie_pedido_id: number | null;
  omie_numero_pedido: string | null;
  omie_payload: OmiePayload | null;
  created_at: string;
}

export interface FormasPagamentoResponse {
  formas?: Array<{ codigo: string; descricao: string }>;
}

export interface OmieProduct {
  id: string;
  omie_codigo_produto: number;
  codigo: string;
  descricao: string;
  unidade: string;
  valor_unitario: number;
  estoque: number;
  ativo: boolean;
  account?: string;
  is_tintometric?: boolean;
  tint_type?: string;
}

export const BLOCKED_STATUSES = ['cancelado', 'entregue', 'faturado'];
