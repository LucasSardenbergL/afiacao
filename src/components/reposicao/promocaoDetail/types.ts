import type { Tables } from "@/integrations/supabase/types";
import type { ComColunas } from "@/lib/reposicao/linha-view";
// Types + constantes compartilhados da tela de detalhe de promoção/campanha.
// Extraídos de src/pages/AdminReposicaoPromocaoDetail.tsx (god-component split).

export const EMPRESA = "OBEN";
export const FORNECEDOR_DEFAULT = "RENNER SAYERLACK S/A";

export type Campanha = Tables<"promocao_campanha">;

export type ItemRow = Tables<"promocao_item">;

export type ItemEfetivo = ComColunas<Pick<Tables<"v_promocao_item_efetivo">, "id" | "desconto_efetivo">, "id" | "desconto_efetivo">;

export type Evento = Tables<"promocao_negociacao_evento">;

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
