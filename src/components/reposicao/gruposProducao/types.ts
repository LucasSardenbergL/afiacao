// Constantes, tipos e helpers dos Grupos de Produção (AdminReposicaoGruposProducao).
// Extraídos de src/pages/AdminReposicaoGruposProducao.tsx (god-component split).

export const EMPRESA = "OBEN";
export const ALL = "__all__";
export const SEM_GRUPO = "__sem_grupo__";
export const PAGE_SIZE = 50;

export type Grupo = {
  id: number;
  empresa: string;
  fornecedor_nome: string;
  grupo_codigo: string;
  descricao: string | null;
  lt_producao_dias: number;
  lt_producao_unidade: string;
  horario_corte: string | null;
  observacoes: string | null;
};

export type SkuRow = {
  empresa: string;
  sku_codigo_omie: number;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  grupo_codigo: string | null;
};

export type SkuGrupoRow = {
  sku_codigo_omie: string | number;
  grupo_codigo: string;
};

export type SkuParametroRow = {
  empresa: string;
  sku_codigo_omie: string | number;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
};

export const emptyGrupo = (): Partial<Grupo> => ({
  empresa: EMPRESA,
  fornecedor_nome: "",
  grupo_codigo: "",
  descricao: "",
  lt_producao_dias: 5,
  lt_producao_unidade: "uteis",
  horario_corte: null,
  observacoes: "",
});
