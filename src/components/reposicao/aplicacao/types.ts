// Tipos + constantes da tela de Aplicação no Omie.
// Extraídos de src/pages/AdminReposicaoAplicacao.tsx (god-component split).

export const EMPRESA = "OBEN";

// Tabelas custom (fila_aplicacao_omie, sku_substituicao) e RPCs
// (gerar_fila_aplicacao_omie, registrar_substituicao_sku) ainda não estão no
// Database type gerado. Quando entrarem, podem ser substituídos por Tables<>.
export type FilaItem = {
  id: number;
  empresa: string;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  estoque_minimo_novo: number | null;
  ponto_pedido_novo: number | null;
  estoque_maximo_novo: number | null;
  estoque_minimo_omie_atual: number | null;
  ponto_pedido_omie_atual: number | null;
  estoque_maximo_omie_atual: number | null;
  status_validacao: string;
  mensagem_bloqueio: string | null;
  delta_max_perc: number | null;
  aplicado_em: string | null;
  resposta_omie: Record<string, unknown> | null;
  erro_omie: string | null;
  criado_em: string;
};

export interface GerarFilaResult {
  prontos?: number;
  bloqueados_inativos?: number;
  bloqueados_substituicao?: number;
}

export interface RegistrarSubstResult {
  error?: string;
}

export interface SkuParametroOpcao {
  sku_codigo_omie: number;
  sku_descricao: string | null;
}
