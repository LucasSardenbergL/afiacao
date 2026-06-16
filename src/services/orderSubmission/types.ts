import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import type { PrintOrderData } from '@/components/OrderPrintLayout';
import type {
  OmieCustomer,
  ProductCartItem,
  ServiceCartItem,
  FormaPagamento,
  AddressData,
  CompanyProfile,
} from '@/hooks/unifiedOrder/types';
import type { DeliveryOption } from '@/types';

export type SubmitClient = SupabaseClient<Database>;

export interface SubmitCart {
  obenProductItems: ProductCartItem[];
  colacorProductItems: ProductCartItem[];
  serviceItems: ServiceCartItem[];
}

export interface SubmitSubtotals {
  oben: number;
  colacor: number;
  service: number;
}

export interface SubmitVolumes {
  oben: number;
  colacor: number;
}

export interface SubmitPayment {
  parcelaOben: string;
  parcelaColacor: string;
  afiacaoMethod: string;
  formasPagamentoOben: FormaPagamento[];
  formasPagamentoColacor: FormaPagamento[];
}

export interface SubmitDelivery {
  option: DeliveryOption;
  selectedAddress: AddressData | undefined;
}

export interface SubmitMeta {
  notes: string;
  readyByDate: string;
  ordemCompra: string;
}

export interface SubmitOrderParams {
  customer: OmieCustomer;
  customerUserId: string | null;
  user: User;
  cart: SubmitCart;
  subtotals: SubmitSubtotals;
  volumes: SubmitVolumes;
  payment: SubmitPayment;
  delivery: SubmitDelivery;
  meta: SubmitMeta;
  companyProfiles: Record<string, CompanyProfile>;
  defaultProductionAssigneeId: string | null;
  getServicePrice: (item: ServiceCartItem) => number | null;
  supabase: SubmitClient;
  /** True em autoatendimento (cliente não-staff): cliente sintético
   *  (codigo_cliente=0, sem código por-conta), só itens de afiação; o edge
   *  resolve a identidade por user/documento. Desliga o preflight de identidade
   *  por-conta (que é regra de pedido STAFF multi-conta). Default: false. */
  isCustomerMode?: boolean;
  /** Chave de idempotência por TENTATIVA de envio (estável entre retries; ver useUnifiedOrder). */
  checkoutId: string;
  /** Canal de origem. Na Fase 0 é null/'web_*'; a Fase 1 grava 'ligacao_sainte' etc. */
  origem?: string | null;
  /** Liga ligação ↔ N pedidos. null na Fase 0 (Fase 1 preenche). */
  atendimentoId?: string | null;
}

export interface SubmitErrorEntry {
  step: string;
  message: string;
}

export interface LastOrderItem {
  description: string;
  quantity: number;
  unitPrice: number;
  codigo?: string;
  unidade?: string;
  tintCorId?: string;
  tintNomeCor?: string;
}

export interface LastOrderDataShape {
  customerName: string;
  customerDocument: string;
  items: LastOrderItem[];
  total: number;
  orderNumbers: string[];
  printDataList: PrintOrderData[];
}

export interface SubmitOrderResult {
  success: boolean;
  results: string[];
  printDataList: PrintOrderData[];
  lastOrderData: LastOrderDataShape | null;
  errors: SubmitErrorEntry[];
  /** true só quando TODA conta com itens foi confirmada/reconciliada (sem 'pendente ERP').
   *  O caller usa isso p/ decidir limpar o carrinho + resetar o checkout_id (idempotência). */
  allConfirmed: boolean;
}

export interface SubmitQuoteParams {
  customer: OmieCustomer;
  customerUserId: string | null;
  user: User;
  cart: Pick<SubmitCart, 'obenProductItems' | 'colacorProductItems'>;
  subtotals: Pick<SubmitSubtotals, 'oben' | 'colacor'>;
  delivery: SubmitDelivery;
  meta: Pick<SubmitMeta, 'notes'>;
  supabase: SubmitClient;
}

export interface SubmitQuoteResult {
  success: boolean;
  results: string[];
  errors: SubmitErrorEntry[];
}
