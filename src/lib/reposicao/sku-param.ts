/**
 * Tipos + helpers compartilhados entre AdminReposicaoRevisao (page) e
 * SkuDetailSheet (componente extraído). Extraído pra esta lib durante o refactor
 * de god-component (PR proof-of-concept).
 *
 * Padrão: types descrevem o shape das views/tabelas Supabase de reposição;
 * helpers formatam badges + valores numéricos consistentemente.
 */

export type SkuParam = {
  id: string;
  empresa: string;
  sku_codigo_omie: number;
  sku_descricao: string | null;
  fornecedor_nome: string | null;
  classe_consolidada: string | null;
  classe_abc: string | null;
  classe_xyz: string | null;
  demanda_media_diaria: number | null;
  demanda_desvio_padrao: number | null;
  demanda_coef_variacao: number | null;
  demanda_dias_com_movimento: number | null;
  demanda_total_90d: number | null;
  valor_vendido_90d: number | null;
  lt_medio_dias_uteis: number | null;
  lt_desvio_padrao_dias: number | null;
  lt_p95_dias: number | null;
  lt_n_observacoes: number | null;
  fonte_leadtime: string | null;
  estoque_minimo: number | null;
  ponto_pedido: number | null;
  estoque_maximo: number | null;
  estoque_seguranca: number | null;
  // Mínimo de compra forçado por SKU (a "R"). Quando >0, a RPC eleva qtde_final ao máximo
  // entre a sugestão natural e este valor — só para item que já precisa repor. NULL = sem piso.
  minimo_forcado_manual: number | null;
  z_score: number | null;
  cobertura_alvo_dias: number | null;
  aplicar_no_omie: boolean | null;
  aprovado_em: string | null;
  aprovado_por: string | null;
  justificativa_aprovacao: string | null;
  ultima_atualizacao_calculo: string | null;
  // Estado de reposição: 'automatica'/null = no motor; 'produto_acabado' = fabricado ('04');
  // 'descontinuado' = desligado de propósito pelo humano (botão "descontinuar SKU" nos Pedidos).
  // Opcional no tipo (os literais de view não o fornecem); o select('*') o traz em runtime.
  tipo_reposicao?: string | null;
};

export type ViewStats = {
  pico_maximo_dia: number | null;
  p95_diario: number | null;
  p90_quando_vende: number | null;
  dias_seguranca: number | null;
  cobertura_alvo_dias: number | null;
  preco_compra_real: number | null;
  preco_venda_medio: number | null;
  preco_item_eoq: number | null;
  fonte_preco: string | null;
  n_compras: number | null;
  custo_capital_efetivo_perc: number | null;
  custo_pedido_aplicado: number | null;
  modo_pedido: string | null;
  z_aplicado: number | null;
  demanda_sigma_diario: number | null;
  sigma_lt_d: number | null;
  lead_time_medio: number | null;
  qtde_compra_ciclo_sugerida: number | null;
};

export type RowWithPrice = SkuParam & {
  preco_compra_real: number | null;
  preco_venda_medio: number | null;
  preco_item_eoq?: number | null; // custo USADO na conta (cmc do Omie quando há; senão média/estimado)
  fonte_preco: string | null;
  status_sugestao?: string | null;
  fornecedor_habilitado?: boolean | null;
  read_only?: boolean;
  // Extras da trilha CANDIDATO_PRIMEIRA_COMPRA (cold-start) — só preenchidos no filtro 'primeira_compra'
  primeira_compra_qtde?: number | null;
  recorrencia_meses_180d?: number | null;
  recorrencia_nfs_180d?: number | null;
  recorrencia_clientes_180d?: number | null;
  dias_desde_ultima_venda?: number | null;
  ja_habilitado?: boolean | null;
};

export type StatusFilterValue = 'pendente' | 'aprovado' | 'aguardando_fornecedor' | 'primeira_compra' | 'todos' | 'descontinuados';

export const fonteBadgeVariant = (
  fonte: string | null | undefined,
): 'success' | 'warning' | 'danger' | 'outline' => {
  if (!fonte) return 'danger';
  const f = fonte.toLowerCase();
  if (f === 'cmc') return 'success';
  if (f.includes('compra') && f.includes('real')) return 'success';
  if (f.includes('estim')) return 'warning';
  if (f.includes('sem')) return 'danger';
  return 'outline';
};

export const fonteBadgeLabel = (fonte: string | null | undefined): string => {
  if (!fonte) return 'Sem preço';
  const f = fonte.toLowerCase();
  if (f === 'cmc') return 'Custo Omie';
  if (f.includes('compra') && f.includes('real')) return 'Compra real';
  if (f.includes('estim')) return 'Estimado';
  if (f.includes('sem')) return 'Sem preço';
  return fonte;
};

export const classBadge = (classe: string | null): string => {
  if (!classe) return 'secondary';
  const c = classe[0];
  if (c === 'A') return 'destructive';
  if (c === 'B') return 'default';
  return 'secondary';
};

export const fmt = (v: number | null | undefined, dec = 2): string =>
  v == null
    ? '—'
    : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });

export const fmtBRL = (v: number | null | undefined): string =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** SKU desligado de propósito pelo humano (botão "descontinuar SKU" nos Pedidos). */
export const isDescontinuado = (row: { tipo_reposicao?: string | null }): boolean =>
  row.tipo_reposicao === 'descontinuado';

/**
 * Campos que religam um SKU descontinuado ao motor de reposição automática.
 * tipo='automatica' é seguro mesmo num fabricado '04' — a guarda do motor barra '04'
 * independentemente (#527/#529). Religar SÓ `habilitado` deixaria tipo='descontinuado'
 * e o motor seguiria barrando; por isso o payload reseta os DOIS campos.
 */
export const reativarPayload = (): { habilitado_reposicao_automatica: true; tipo_reposicao: 'automatica' } => ({
  habilitado_reposicao_automatica: true,
  tipo_reposicao: 'automatica',
});
