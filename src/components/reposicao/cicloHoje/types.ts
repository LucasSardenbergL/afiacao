// Constantes e tipos do painel "Ciclo de hoje".
// Extraídos verbatim de src/components/reposicao/CicloHojePanel.tsx (god-component split).
// ALL é re-exportado pelo arquivo principal (consumidor: AdminReposicaoSessaoPedidos).

export const ALL = "__all__";

export type ConfLevel = "alta" | "media" | "baixa";

export interface CicloFilters {
  search: string;
  fornecedor: string;
  status: string;
}
