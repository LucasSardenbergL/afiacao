// Tipos da tela de edição de pedido de venda.
// Extraídos verbatim de src/pages/SalesOrderEdit.tsx (god-component split).
import type { Tables } from '@/integrations/supabase/types';
import type { ItemPedidoJson, OmiePayloadJson } from '@/lib/pedido/itens-json';

/**
 * Item do pedido como vive no jsonb `sales_orders.items` — lido pela borda `itensPedidoDoJson`.
 * `valor_unitario` `null` = preço NÃO SABIDO: o guard de fronteira (invalidPricedOrderItemIndices)
 * já o trata como inválido e BLOQUEIA o salvar. Editar o `valor_unitario` de um item tint à mão limpa
 * os metadados `tint_*` de precificação (o item vira "legado" e o gate valida pelo piso).
 */
export type OrderItem = ItemPedidoJson;

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
  omie_payload: OmiePayloadJson | null;
  created_at: string;
}

/**
 * Resposta da action `listar_formas_pagamento`. `source`/`degraded`/`motivo` são ADITIVOS
 * (edge #1597) e opcionais: edge antiga — ou ainda não deployada — devolve só `formas`, e a
 * leitura em `@/services/orderSubmission/formasDegradacao` trata a ausência como NÃO-degradado.
 */
export interface FormasPagamentoResponse {
  formas?: Array<{ codigo: string; descricao: string }>;
  source?: string | null;
  degraded?: boolean | null;
  motivo?: string | null;
}

/** Linha do catálogo de edição (as colunas do select em `useSalesOrderEdit`). `estoque` NULL = não sincronizado. */
export type OmieProduct = Pick<
  Tables<'omie_products'>,
  | 'id' | 'omie_codigo_produto' | 'codigo' | 'descricao' | 'unidade' | 'valor_unitario' | 'estoque' | 'ativo'
  | 'account' | 'is_tintometric' | 'tint_type'
>;

export const BLOCKED_STATUSES = ['cancelado', 'entregue', 'faturado'];
