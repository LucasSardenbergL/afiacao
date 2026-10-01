// Tipos do Assistente de Pedido IA.
// Extraídos verbatim de src/components/UnifiedAIAssistant.tsx (god-component split).
// As interfaces públicas (AIProduct/AIService/AISuggestion/AICustomerMatch/AIOrderResult)
// são re-exportadas pelo arquivo principal para preservar os imports existentes.

// Sem `unit_price` em AIProduct/AISuggestion: a IA NÃO precifica. O item nasce no carrinho pelo
// mesmo `getProductPrice` da lista (src/hooks/unifiedOrder/nascimento-item.ts) e a edge
// `analyze-unified-order` não manda preço (fronteira `montarRespostaAnalise`). Tirar do TIPO faz o
// compilador recusar quem voltar a ler um preço da IA.
export interface AIProduct {
  product_id: string;
  codigo: string;
  descricao: string;
  quantity: number;
  account: 'oben' | 'colacor';
  notes?: string;
}

export interface AIService {
  userToolId: string;
  omie_codigo_servico: number;
  servico_descricao: string;
  quantity: number;
  notes?: string;
}

export interface AISuggestion {
  type: 'product' | 'service';
  product_id?: string;
  codigo?: string;
  descricao: string;
  quantity?: number;
  account?: string;
  reason: string;
  userToolId?: string;
  omie_codigo_servico?: number;
  servico_descricao?: string;
}

export interface AICustomerMatch {
  nome_fantasia: string;
  razao_social: string;
  cnpj_cpf: string;
  cidade?: string;
  codigo_cliente: number;
  confidence: 'high' | 'medium' | 'low';
  user_id?: string | null;
}

export interface AIOrderResult {
  products: AIProduct[];
  services: AIService[];
  suggestions?: AISuggestion[];
  customer?: AICustomerMatch | null;
}

export interface Product {
  id: string;
  codigo: string;
  descricao: string;
  valor_unitario: number;
  estoque: number;
  account?: string;
}

export interface UserTool {
  id: string;
  tool_category_id: string;
  generated_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  tool_categories?: { name: string } | null;
}

export interface ImageAttachment {
  preview: string;
  base64: string;
}

export interface UnifiedAIAssistantProps {
  products: Product[];
  userTools: UserTool[];
  onItemsIdentified: (result: AIOrderResult) => void;
  onCustomerIdentified?: (customer: AICustomerMatch) => void;
  customerUserId?: string | null;
  hasCustomerSelected?: boolean;
  isLoading?: boolean;
  /** Preço com que o item VAI nascer no carrinho (= getProductPrice da lista), pelo id do catálogo.
   *  É o único preço que o painel exibe; null = fora do catálogo carregado (não exibe número).
   *  OBRIGATÓRIO: opcional, um caller que o esquecesse deixaria o painel sem preço em silêncio. */
  precoNascimentoPorId: (productId: string) => number | null;
  /** Preço de partida ainda não firme (tier/config carregando): o painel não exibe número e o ADD
   *  fica bloqueado — o MESMO gate do ADD da lista (`precoLoading` do ProductItemForm). */
  precoLoading?: boolean;
}
