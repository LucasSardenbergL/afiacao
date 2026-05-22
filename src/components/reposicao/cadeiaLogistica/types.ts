export type Etapa = {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  ordem: number;
  etapa_codigo: string;
  descricao: string;
  lt_dias: number;
  lt_unidade: string;
  parceiro_nome: string | null;
  parceiro_tipo: string | null;
  parceiro_contato: string | null;
  ativo: boolean;
  valido_desde: string | null;
  valido_ate: string | null;
  observacoes: string | null;
};

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
