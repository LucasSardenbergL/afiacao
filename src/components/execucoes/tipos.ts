// Tipos do registro de execuções de ações globais (tabela acoes_execucoes).
// A tabela ainda não está no types.ts gerado (regen é do Lovable) — o shape canônico é este.
export interface AcaoExecucao {
  id: string;
  acao: string;
  origem: "manual" | "automatica";
  executado_por: string | null;
  executado_por_nome: string | null;
  iniciado_em: string;
  finalizado_em: string | null;
  status: "executando" | "sucesso" | "erro";
  detalhes: Record<string, unknown> | null;
}

export const ULTIMA_EXECUCAO_QUERY_KEY = "ultima-execucao";
