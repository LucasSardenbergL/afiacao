import type { OmieServico } from '@/services/omieService';

/* ─── Shared types for unified order module ─── */

export type ProductAccount = 'oben' | 'colacor';

/**
 * Famílias de produtos excluídas do catálogo de vendas (Oben + Colacor).
 * Centralizado aqui para evitar duplicação entre loadProductsForAccount,
 * o reload pós-sync e o syncStockInBackground.
 */
export const EXCLUDED_FAMILIA_PATTERNS = [
  '%imobilizado%',
  '%uso e consumo%',
  '%matérias primas para conversão de cintas%',
  '%jumbos de lixa para discos%',
  'jumbo%',
  '%material para tingimix%',
] as const;

/**
 * Aplica os filtros de exclusão de família a uma query do Supabase.
 * Use sempre que listar de `omie_products` no contexto de venda.
 */
export function buildExclusionQuery<T extends { not: (col: string, op: string, val: string) => T }>(
  query: T,
): T {
  let q = query;
  for (const pattern of EXCLUDED_FAMILIA_PATTERNS) {
    q = q.not('familia', 'ilike', pattern);
  }
  return q;
}

export interface Product {
  id: string;
  codigo: string;
  descricao: string;
  unidade: string;
  valor_unitario: number;
  estoque: number;
  ativo: boolean;
  omie_codigo_produto: number;
  account?: string;
  is_tintometric?: boolean;
  tint_type?: string;
  metadata?: Record<string, any> | null;
}

export interface ProductCartItem {
  type: 'product';
  product: Product;
  quantity: number;
  unit_price: number;
  account: ProductAccount;
  // Tintometric optional fields
  tint_cor_id?: string;
  tint_nome_cor?: string;
  tint_custo_corantes?: number;
  tint_formula_id?: string;
}

export interface UserTool {
  id: string;
  tool_category_id: string;
  generated_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  specifications: Record<string, unknown> | null;
  tool_categories?: { name: string };
}

export interface ServiceCartItem {
  type: 'service';
  userTool: UserTool;
  servico: OmieServico | null;
  quantity: number;
  notes?: string;
  photos: string[];
}

export type CartItem = ProductCartItem | ServiceCartItem;

export interface OmieCustomer {
  codigo_cliente: number;
  razao_social: string;
  nome_fantasia: string;
  cnpj_cpf: string;
  codigo_vendedor: number | null;
  local_user_id?: string | null;
  codigo_cliente_colacor?: number | null;
  codigo_vendedor_colacor?: number | null;
  codigo_cliente_afiacao?: number | null;
  codigo_vendedor_afiacao?: number | null;
  // Address fields from Omie
  endereco?: string;
  endereco_numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  cep?: string;
  telefone?: string;
  contato?: string;
  // Segment/tags from Omie
  tags?: string[];
  atividade?: string;
  segment?: string;
}

export interface FormaPagamento {
  codigo: string;
  descricao: string;
}

export interface CompanyProfile {
  account: string;
  legal_name: string;
  cnpj: string;
  phone: string | null;
  address: string | null;
}

export interface AddressData {
  id: string;
  label: string;
  street: string;
  number: string;
  complement: string | null;
  neighborhood: string;
  city: string;
  state: string;
  zipCode: string;
}

export interface ToolCategory {
  id: string;
  name: string;
  description: string | null;
  suggested_interval_days: number | null;
}
