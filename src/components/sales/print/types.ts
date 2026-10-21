// Tipos, constantes e helpers da Impressão de Pedidos (SalesPrintDashboard).
// Extraídos de src/pages/SalesPrintDashboard.tsx (god-component split).
import type { Json } from '@/integrations/supabase/types';
import { ehDataPuraUtc } from '@/lib/pedido/data-pedido';

export type CompanyFilter = 'oben' | 'colacor' | 'afiacao';

export const COMPANY_LABELS: Record<CompanyFilter, string> = {
  oben: 'Oben',
  colacor: 'Colacor',
  afiacao: 'Afiação',
};

export const COMPANY_COLORS: Record<CompanyFilter, string> = {
  oben: 'bg-blue-100 text-blue-800 border-blue-300',
  colacor: 'bg-rose-100 text-rose-800 border-rose-300',
  afiacao: 'bg-amber-100 text-amber-800 border-amber-300',
};

export interface OrderItem {
  codigo?: string;
  omie_codigo?: string;
  descricao?: string;
  nome?: string;
  quantidade?: number;
  unidade?: string;
  /** `null` = preco NAO SABIDO (o Omie nao informou). No cupom sai "-", nunca R$ 0,00. */
  valor_unitario?: number | null;
  valor_total?: number | null;
  tint_cor_id?: string;
  tint_nome_cor?: string;
  [k: string]: unknown;
}

export interface OmiePayload {
  cabecalho?: {
    codigo_parcela?: string;
    codigo_cliente?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface SalesOrderRow {
  id: string;
  customer_user_id: string;
  items: OrderItem[];
  subtotal: number;
  total: number;
  desconto?: number;
  frete?: number;
  status: string;
  omie_numero_pedido: string | null;
  created_at: string;
  notes: string | null;
  account?: string;
  customer_name?: string;
  customer_document?: string;
  customer_phone?: string;
  customer_address?: string;
  vendedor_name?: string;
  cond_pagamento?: string;
  user_id?: string;
  omie_payload?: OmiePayload;
}

export interface ProfileLite {
  user_id: string;
  name: string | null;
  document: string | null;
  phone: string | null;
}

export interface AddressLite {
  user_id: string;
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string;
  zip_code: string;
  is_default: boolean | null;
}

/** Pedido após enriquecimento (perfil/endereço) + a empresa resolvida. */
export type EnrichedOrder = SalesOrderRow & { _company: CompanyFilter };

export function getPeriod(dateStr: string): 'manha' | 'tarde' {
  const d = new Date(dateStr);
  // Data-pura do sync Omie (meia-noite UTC, sem hora real): o relógio local fabricaria
  // "21:00 → tarde" em BRT. Classifica pelo relógio UTC (00:00 → manhã), coerente com
  // o dia civil UTC usado no filtro do dia (pedidoNoDiaCivil).
  const h = ehDataPuraUtc(d) ? d.getUTCHours() : d.getHours();
  return h < 12 ? 'manha' : 'tarde';
}

/**
 * `items` (jsonb) como a impressão o consome: cada item é objeto livre — o `OrderItem` acima é
 * frouxo de propósito, porque a folha imprime pedido de venda e pedido de AFIAÇÃO (`orders.items`,
 * outra forma: category/name/quantity/unitPrice). NULL = sem itens; não-array ou item não-objeto lança.
 */
export function itensImpressaoDoJson(v: Json | null, fonte: string): OrderItem[] {
  if (v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${fonte}: items não é array`);
  return v.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`${fonte}: item ${i} não é objeto`);
    }
    return item;
  });
}
