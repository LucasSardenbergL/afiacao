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
 * Caracteres que quebram a ESTRUTURA do predicado `.or()` do PostgREST: vírgula
 * (separa cláusulas), parênteses (agrupam) e aspas duplas (delimitam valor). NÃO
 * inclui os wildcards do ILIKE (`%` `_`), que são intencionais nos patterns.
 */
const POSTGREST_OR_STRUCTURAL = /[,()"]/;

/**
 * Monta o predicado do `.or()` que exclui as famílias indesejadas SEM descartar
 * produtos com `familia` NULL.
 *
 * O `.not('familia','ilike',p)` encadeado vira `familia NOT ILIKE p`, que avalia
 * para NULL quando `familia` é NULL → a linha some (footgun, CLAUDE.md §10).
 * Aqui geramos `familia IS NULL OR (familia NOT ILIKE p1 AND ...)`, no formato do
 * PostgREST: `familia.is.null,and(familia.not.ilike.p1,...)`.
 *
 * Os patterns são CONSTANTES confiáveis (`EXCLUDED_FAMILIA_PATTERNS`), não input
 * do usuário — por isso NÃO passam por `sanitizeForPostgrestOr` (que removeria o
 * `%` do ILIKE parcial). Como contrapartida da não-sanitização, validamos que
 * nenhum pattern carrega um metacaractere estrutural: money-path, falhar alto é
 * melhor que query silenciosamente errada.
 */
export function buildFamiliaExclusionOrFilter(patterns: readonly string[]): string {
  if (patterns.length === 0) {
    // Sem patterns geraria `familia.is.null,and()` → 400 do parser → catálogo
    // vira [] silencioso. Falha alto: chamar com lista vazia é bug de programação.
    throw new Error('buildFamiliaExclusionOrFilter requer ao menos um pattern de família');
  }
  for (const pattern of patterns) {
    if (POSTGREST_OR_STRUCTURAL.test(pattern)) {
      throw new Error(
        `Pattern de família inválido para .or() do PostgREST: ${JSON.stringify(pattern)} (contém , ( ) ou ")`,
      );
    }
  }
  const nots = patterns.map((pattern) => `familia.not.ilike.${pattern}`).join(',');
  return `familia.is.null,and(${nots})`;
}

/**
 * Aplica os filtros de exclusão de família a uma query do Supabase.
 * Use sempre que listar de `omie_products` no contexto de venda.
 */
export function buildExclusionQuery<T extends { or: (filter: string) => T }>(query: T): T {
  return query.or(buildFamiliaExclusionOrFilter(EXCLUDED_FAMILIA_PATTERNS));
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
  metadata?: Record<string, unknown> | null;
  /** Tipo fiscal do Omie: '04'=Produto Acabado (fabricado → vira OP em vez de compra). Coluna
   * dedicada (Migration 2026-06-04); `metadata.tipo_produto` é fallback legado da transição. */
  tipo_produto?: string | null;
}

export interface ProductCartItem {
  type: 'product';
  product: Product;
  quantity: number;
  unit_price: number;
  account: ProductAccount;
  // Preço de PARTIDA no nascimento (precoPartida). Enquanto unit_price === precoNascimento o
  // vendedor NÃO editou → a reprecificação da fronteira pode corrigir um item que nasceu antes
  // do tier/mult firmarem (Codex P1-A: guard na fronteira, não só na UI da lista). Ausente em
  // itens nascidos por preço externo (IA aiPrice) ou tint — esses nunca são reprecificados.
  precoNascimento?: number;
  // Tintometric optional fields
  tint_cor_id?: string;
  tint_nome_cor?: string;
  tint_custo_corantes?: number;
  tint_formula_id?: string;
  // Fase 3: metadados de precificação do picker — a fonte que a vendedora
  // escolheu + o desconto declarado + o preço-base. Viajam no jsonb e no
  // payload do edge; o gate do submit (tint_gate_revalida) recomputa a fonte
  // AGORA e confere. Ausentes = item legado (o gate usa o piso min(fontes)).
  tint_price_source?: string;
  tint_discount_pct?: number;
  tint_preco_sem_desconto?: number;
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
