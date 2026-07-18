// Tipos e helpers puros dos Alertas de Outlier (AdminReposicaoAlertas).
// Extraídos de src/pages/AdminReposicaoAlertas.tsx (god-component split).

export const PAGE_SIZE = 25;

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" | "danger" | "purple" | "indigo";

export interface OutlierDetalhes {
  fornecedor?: string;
  mensagem?: string;
  [k: string]: unknown;
}

export type EventoOutlier = {
  id: number;
  empresa: string;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  tipo: string;
  severidade: string;
  data_evento: string;
  valor_observado: number | null;
  valor_esperado: number | null;
  desvios_padrao: number | null;
  detalhes: OutlierDetalhes | null;
  status: string;
  decidido_em: string | null;
  decidido_por: string | null;
  justificativa_decisao: string | null;
  detectado_em: string | null;
};

export type OutlierStats = {
  pendentes: number;
  criticos: number;
  atencao: number;
  info: number;
  aceitosHoje: number;
  excluidosHoje: number;
};

export type SkuInfo = {
  classe_consolidada: string | null;
  demanda_media_diaria: number | null;
  demanda_sigma_diario: number | null;
  lt_medio_dias_uteis: number | null;
  preco_compra_real: number | null;
};

export type GrupoRow = { id: number; codigo_grupo: string; descricao: string | null; lt_producao_dias: number };

// Sem `tipo`: 'aceitar' virou a única decisão, então o campo não distingue mais nada e
// ninguém o lê. 'excluir' saiu (prometia remover da estatística e nunca alcançou o motor —
// spec 2026-07-16); 'ignorar' saiu junto (arquivava igual a 'aceitar' e nunca foi usado).
// Resta só o que ainda decide layout e alvo: se a confirmação é de lote ou individual.
export type AcaoConfirm = { lote: boolean };

export const tipoLabel = (tipo: string) =>
  tipo === "venda_atipica"
    ? "Venda atípica"
    : tipo === "lt_atipico"
    ? "LT atípico"
    : tipo === "sku_sem_grupo"
    ? "SKU sem grupo"
    : tipo;

export const fmt = (n: number | null | undefined, dec = 2) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
