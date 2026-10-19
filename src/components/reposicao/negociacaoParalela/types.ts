import type { Tables } from "@/integrations/supabase/types";
import { exigirColunas, type ComColunas } from "@/lib/reposicao/linha-view";
// Types + constantes da tela de negociação paralela (sugestões de campanha).
// Extraídos de src/pages/AdminReposicaoNegociacaoParalela.tsx (god-component split).

export const EMPRESA = "OBEN";

export type StatusSugestao =
  | "nova"
  | "visualizada"
  | "acao_tomada"
  | "ignorada"
  | "fechada_sem_acordo"
  | "convertida";
export type Categoria = "prioritario" | "forte" | "moderado" | "fraco";
export type OrdenacaoKey = "score" | "volume" | "preco" | "expirando";

export const STATUS_SUGESTAO: readonly StatusSugestao[] = ["nova", "visualizada", "acao_tomada", "ignorada", "fechada_sem_acordo", "convertida"];
export function ehStatusSugestao(s: string | null | undefined): s is StatusSugestao {
  return (STATUS_SUGESTAO as readonly string[]).includes(s ?? "");
}
export const CATEGORIA_VALORES: readonly Categoria[] = ["prioritario", "forte", "moderado", "fraco"];
export function ehCategoria(s: string | null | undefined): s is Categoria {
  return (CATEGORIA_VALORES as readonly string[]).includes(s ?? "");
}
// Linha de v_sugestao_negociacao_ativa (view: tudo `| null`). A borda exige id/empresa/sku, estreita
// status/categoria pelos guards e lê motivo_detalhes como objeto — sem `as unknown as`.
export type Sugestao = Omit<
  ComColunas<Tables<"v_sugestao_negociacao_ativa">, "id" | "empresa" | "sku_codigo_omie">,
  "status" | "categoria" | "motivo_detalhes"
> & { status: StatusSugestao; categoria: Categoria | null; motivo_detalhes: Record<string, unknown> | null };

/** Borda banco→UI: lança em status/categoria fora do vocabulário (estado desconhecido não vira card). */
export function comoSugestao(r: Tables<"v_sugestao_negociacao_ativa">): Sugestao {
  exigirColunas(r, ["id", "empresa", "sku_codigo_omie"], "v_sugestao_negociacao_ativa");
  if (!ehStatusSugestao(r.status)) throw new Error(`v_sugestao_negociacao_ativa: status "${r.status}" desconhecido (id ${r.id})`);
  if (r.categoria !== null && !ehCategoria(r.categoria)) throw new Error(`v_sugestao_negociacao_ativa: categoria "${r.categoria}" desconhecida (id ${r.id})`);
  const md = r.motivo_detalhes;
  return {
    ...r,
    status: r.status,
    categoria: r.categoria,
    motivo_detalhes: md !== null && typeof md === "object" && !Array.isArray(md) ? md : null,
  };
}

export interface RankingRow {
  empresa: string;
  sku_codigo_omie: string;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  volume_financeiro_12m: number | null;
  num_compras_12m: number | null;
  meses_com_compra: number | null;
  preco_medio_unitario: number | null;
  coef_variacao: number | null;
  ultima_compra: string | null;
  promocoes_12m: number | null;
  perc_meses_com_promo: number | null;
  score_volume: number | null;
  score_consistencia: number | null;
  score_preco: number | null;
  score_ausencia_promo: number | null;
  score_final: number | null;
  categoria: Categoria | null;
  atualizado_em: string | null;
}

export const CATEGORIAS: Array<{ value: Categoria; label: string }> = [
  { value: "prioritario", label: "Prioritário" },
  { value: "forte", label: "Forte" },
  { value: "moderado", label: "Moderado" },
  { value: "fraco", label: "Fraco" },
];

export const STATUS_LIST: Array<{ value: StatusSugestao; label: string }> = [
  { value: "nova", label: "Nova" },
  { value: "visualizada", label: "Visualizada" },
  { value: "acao_tomada", label: "Em andamento" },
];

export const ORDENACOES: Array<{ value: OrdenacaoKey; label: string }> = [
  { value: "score", label: "Maior score" },
  { value: "volume", label: "Maior volume" },
  { value: "preco", label: "Maior preço unitário" },
  { value: "expirando", label: "Expirando primeiro" },
];

type VolumeUnidade = "unidades" | "reais" | "kg" | "litros";
type CanalNegociacao = "email" | "whatsapp" | "ligacao" | "visita_presencial" | "outro";

export interface ConvertForm {
  sku_codigo_fornecedor: string;
  desconto_perc: number;
  volume_minimo: number;
  volume_unidade: VolumeUnidade;
  data_fim: string;
  responsavel: string;
  canal: CanalNegociacao;
  observacoes: string;
}

// --- Negociação Paralela v2 (fila por R$ líquido) ---

// Linha crua da view v_sku_parametros_sugeridos (subset usado pela fila).
export interface LinhaViewSugeridos {
  sku_codigo_omie: number | string;
  sku_descricao: string | null;
  demanda_media_diaria: number | null;
  preco_compra_real: number | null;
  preco_item_eoq: number | null;     // = CMC quando fonte_preco='cmc'
  fonte_preco: string | null;        // 'cmc' | 'compra_real' | 'venda_estimado' | 'sem_preco'
  custo_capital_efetivo_perc: number | null; // %/ano
}

// Candidato pronto pra UI: identidade + insumos + avaliação corrente (recalculada com o desconto do card).
export interface CandidatoNegociacao {
  sku_codigo_omie: string;
  sku_descricao: string | null;
  consumo_anual: number;
  preco_compra: number | null;
  cmc: number | null;            // só quando fonte_preco='cmc'
  custo_capital_anual: number;
  gasto_anual: number | null;    // preco_compra × consumo_anual (referência exibida)
}
