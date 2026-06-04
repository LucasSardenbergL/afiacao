// Tipos do Mapeamento SKU.
// Extraídos verbatim de src/pages/AdminSkuMapeamento.tsx (god-component split).
import type { GabaritoResult, SugestoesResult } from '@/lib/reposicao/sayerlack-sku';

export interface Mapeamento {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  sku_omie: string;
  sku_portal: string | null;
  unidade_portal: string;
  fator_conversao: number;
  ativo: boolean;
  observacoes: string | null;
  criado_em: string;
  atualizado_em: string;
}

export interface ValidacaoResult {
  faltantes: { empresa: string; fornecedor_nome: string; sku_codigo_omie: string; sku_descricao: string }[]; // do histórico de pedidos
  faltantesMotor: { empresa: string; fornecedor_nome: string; sku_codigo_omie: string; sku_descricao: string }[]; // risco real: o motor pode pedir e o portal recusa
  suspeitos: Mapeamento[];
  total: number;
  automaticos: number;
  manuais: number;
  // Auto-mapeamento via código embutido na descrição (parser sayerlack-sku):
  gabarito?: GabaritoResult; // parser × mapeamentos manuais (prova de segurança)
  sugestoes?: SugestoesResult; // códigos extraídos dos faltantes (seguros prontos pra gravar)
}
