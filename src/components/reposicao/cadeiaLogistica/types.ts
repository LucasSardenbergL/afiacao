import type { Tables } from "@/integrations/supabase/types";
// Linha de fornecedor_cadeia_logistica como o types.ts a conhece (ativo/valido_* são `| null` no banco).
export type Etapa = Tables<"fornecedor_cadeia_logistica">;

export type Fornecedor = {
  empresa: string;
  fornecedor_nome: string;
};

export type HistoricoItem = {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  etapa_codigo: string | null;
  acao: string;
  descricao_mudanca: string;
  criado_em: string;
};
