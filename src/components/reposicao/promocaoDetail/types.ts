// Types + constantes compartilhados da tela de detalhe de promoção/campanha.
// Extraídos de src/pages/AdminReposicaoPromocaoDetail.tsx (god-component split).

export const EMPRESA = "OBEN";
export const FORNECEDOR_DEFAULT = "RENNER SAYERLACK S/A";

export type Campanha = {
  id: number;
  empresa: string;
  nome: string;
  fornecedor_nome: string;
  tipo_origem: string;
  data_inicio: string;
  data_fim: string;
  estado: string;
  observacoes: string | null;
  origem_arquivo_url: string | null;
  origem_arquivo_tipo: string | null;
  origem_email_assunto: string | null;
  origem_email_remetente: string | null;
  origem_email_data: string | null;
  extracao_confianca: number | null;
  extracao_observacoes: string | null;
  extraido_em: string | null;
  criado_em: string;
};

export type ItemRow = {
  id: number;
  campanha_id: number;
  sku_codigo_fornecedor: string;
  descricao_produto_fornecedor: string | null;
  sku_codigo_omie: number | null;
  mapeamento_qualidade: string | null;
  mapeamento_candidatos: unknown;
  desconto_perc: number;
  volume_minimo: number | null;
  confirmado: boolean;
  ativo: boolean;
  desconto_extra_perc: number | null;
  desconto_extra_observacoes: string | null;
  desconto_extra_negociado_por: string | null;
  desconto_extra_negociado_em: string | null;
  desconto_extra_email_referencia: string | null;
};

export type ItemEfetivo = {
  id: number;
  desconto_efetivo: number;
};

export type Evento = {
  id: number;
  campanha_id: number;
  tipo_evento: string;
  desconto_perc_proposto: number | null;
  volume_minimo_proposto: number | null;
  data_evento: string;
  email_referencia: string | null;
  conteudo: string | null;
  registrado_por: string | null;
  registrado_em: string;
};

// Estado do formulário do modal "Registrar evento" (todos os campos como string,
// convertidos no submit). Compartilhado entre a page e EventoDialog.
export type NovoEventoForm = {
  tipo_evento: string;
  desconto_perc_proposto: string;
  volume_minimo_proposto: string;
  data_evento: string;
  email_referencia: string;
  conteudo: string;
};

export const TIPO_EVENTO_LABELS: Record<string, string> = {
  proposta_enviada: "Proposta enviada",
  contraproposta_recebida: "Contra-proposta recebida",
  aceite_lucas: "Aceite (Lucas)",
  aceite_gerente: "Aceite (Gerente)",
  recusa_gerente: "Recusa (Gerente)",
  abandono: "Abandono",
  nota: "Nota",
};

export const ESTADO_LABEL: Record<string, string> = {
  rascunho: "Rascunho",
  negociando: "Negociando",
  ativa: "Ativa",
  encerrada: "Encerrada",
  cancelada: "Cancelada",
};
