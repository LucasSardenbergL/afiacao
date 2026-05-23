// Tipos, constantes e helpers puros da página de Promoções (AdminReposicaoPromocoes).
// Extraídos de src/pages/AdminReposicaoPromocoes.tsx (god-component split).

export const MAX_CONCURRENT = 3;
export const EMPRESA = "OBEN";
export const FORNECEDOR_DEFAULT = "RENNER SAYERLACK S/A";
export const ALL = "__all__";

export type UploadStatus = "aguardando" | "processando" | "concluido" | "erro";

export type UploadItem = {
  id: string;
  file: File;
  status: UploadStatus;
  campanhaId?: number;
  nomeCampanha?: string;
  itensExtraidos?: number;
  confianca?: number | null;
  erro?: string;
};

export type Campanha = {
  id: number;
  nome: string;
  fornecedor_nome: string;
  tipo_origem: string;
  data_inicio: string;
  data_fim: string;
  estado: string;
  extracao_confianca: number | null;
  criado_em: string;
};

export type CampanhaComContagem = Campanha & { num_itens: number };

export const ESTADOS: Array<{ value: string; label: string }> = [
  { value: "rascunho", label: "Rascunho" },
  { value: "negociando", label: "Negociando" },
  { value: "ativa", label: "Ativa" },
  { value: "encerrada", label: "Encerrada" },
  { value: "cancelada", label: "Cancelada" },
];

export function estadoBadgeClass(estado: string): string {
  switch (estado) {
    case "rascunho":
      return "bg-status-warning/15 text-status-warning border-status-warning/30";
    case "negociando":
      return "bg-status-info/15 text-status-info border-status-info/30";
    case "ativa":
      return "bg-status-success/15 text-status-success border-status-success/30";
    case "encerrada":
      return "bg-muted text-muted-foreground border-border";
    case "cancelada":
      return "bg-destructive/15 text-destructive border-destructive/30";
    default:
      return "";
  }
}

export function formatPeriodo(inicio: string, fim: string): string {
  const fmt = (d: string) => {
    const [y, m, day] = d.split("-");
    return `${day}/${m}/${y.slice(2)}`;
  };
  return `${fmt(inicio)} – ${fmt(fim)}`;
}
