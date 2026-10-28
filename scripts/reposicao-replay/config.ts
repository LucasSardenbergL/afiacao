// Constantes do replay TSB (spec 2026-10-20-tsb-estoque-seguranca-design.md §5.9 e plano, Global Constraints).
import type { Classe, Data } from './tipos';

export const CORTE_COORTE: Data = '2026-05-01';

/** Início do aquecimento = primeira data das vendas OBEN no extrato (confira com o dado real). */
export const INICIO_AQUECIMENTO: Data = '2025-10-21';

export const JANELAS = {
  aquecimentoFim: '2026-01-31',
  calibracaoIni: '2026-02-01',
  calibracaoFim: '2026-04-30',
  avaliacaoIni: '2026-05-01',
  avaliacaoFim: '2026-10-20',
} as const;

/** Semanas observadas antes do corte para definir "parado" (<= 1 semana com venda). */
export const SEMANAS_PARADO = 27;
export const MAX_SEMANAS_COM_VENDA_PARADO = 1;

/** LT máximo observado (du): documento sem t4 com mais du decorridos que isso sai da amostra (SEM_T4_REGISTRADO). */
export const LT_MAX_OBSERVADO_DU = 29;
/** Piso do LT imputado a pedido aberto (du). */
export const LT_ABERTO_MIN_DU = 15;
/** Sorteio de documento de LT: janela de t1 em du em torno do dia. */
export const JANELA_SORTEIO_LT_DU = 10;

export const TSB = {
  alfa: 0.1,
  betas: [0.005, 0.01, 0.02],
  trajetorias: 2000,
  diasInicializacao: 63,
} as const;

export const F1_JANELA_DU = 63;
export const MIN_RECEBIMENTOS_SKU_LT = 5;

export const PISOS_SERVICO: Record<Classe, number> = { A: 0.98, B: 0.95, C: 0.9 };
/** Alvo por classe = max(piso, fillRateF0_calibração - 0,25 p.p.). */
export const FOLGA_ALVO_PP = 0.0025;

export const PRECISAO = {
  bootstrapReamostragens: 2000,
  replicacoesIniciais: 200,
  passoReplicacoes: 100,
  tetoReplicacoes: 1000,
  meiaLarguraServico: 0.001,
  meiaLarguraEstoque: 0.01,
  blocosSemanas: [4, 8],
} as const;

export const GRADE_CUSTO = {
  taxaAnual: [0.2, 0.25, 0.3],
  taxaBase: 0.25,
  emergencial: [0.05, 0.1, 0.2],
  atrasoPorDia: [0, 0.005, 0.01],
} as const;

export const CENARIOS_FALTA = {
  servico: ['espera', 'cancelamento'],
  economia: ['espera', 'cancelamento', 'misto'],
  /** Spec §6: 60% espera, 30% compra EMERGENCIAL, 10% cancelamento (nomes explícitos; revisão final I1). */
  misto: { espera: 0.6, emergencial: 0.3, cancelamento: 0.1 },
} as const;
export const CENARIOS_LT = ['empirico', 'estresse15', 'choque29'] as const;
/** Choque de LT: semanas 9–12 da avaliação. */
export const CHOQUE_LT_SEMANAS = { de: 9, ate: 12 } as const;

export const EXPOSICAO_MINIMA_LINHAS = 300;

export const NOME_METRICA_SERVICO = 'atendimento das linhas faturadas observadas';

/** Arquivos CSV obrigatórios (ordem estável por nome para o hash). */
export const CSVS_REPLAY = [
  'classificacao_hist',
  'config_custos',
  'demanda_insumo',
  'equivalencias',
  'parametros_view',
  'recebimentos',
  'skus',
  'sugestao_hoje',
  'teto',
  'vendas',
] as const;

// ── F0 (motor atual), medido na PRODUÇÃO em 2026-10-21 via psql-ro (pg_get_viewdef/pg_get_functiondef) ──────────────
/** Mínimo operacional por classe ABC PROPOSTA (CTE `minimo_operacional` de v_sku_parametros_sugeridos). */
export const MINIMO_OPERACIONAL_POR_CLASSE: Record<Classe, number> = { A: 2, B: 1, C: 0 };
/**
 * LT teórico (du) por grupo de produção = v_sku_lt_teorico: lt_producao (fornecedor_grupo_producao, unidade 'uteis') +
 * logística (v_fornecedor_lt_logistica_total, Sayerlack = 2 du): rápido 5+2, normal 8+2. Config de HOJE (sem histórico de
 * vigência). Grupo fora deste mapa = sem LT teórico (null), como o LEFT JOIN da view.
 */
export const LT_TEORICO_DU: Record<string, number> = { sayerlack_rapido: 7, sayerlack_normal: 10 };
/** Fusível de atualizar_parametros_numericos_skus: company_config.param_auto_fusivel_mult (3 em prod). */
export const FUSIVEL_PARAM_MULT = 3;
export const F0 = {
  janelaDemandaDias: 90,
  janelaSigmaDias: 180,
  /** v_sku_leadtime_estatisticas: t2_data_faturamento >= hoje - 180 dias (t4 só quando t2 ausente). */
  janelaLtDias: 180,
  /** SKU com >= 3 observações usa o próprio LT; senão o do fornecedor. */
  minObsLtSku: 3,
  ltPadrao: 10,
  fatorSigmaLtPadrao: 0.3,
  diasAnoEoq: 252,
  fatorPrecoVenda: 0.55,
  /**
   * O motor só começa a rodar no replay depois de 28 dias corridos observados: a janela de 90/180 dias anterior ao início
   * do extrato não existe (não é zero), e com 1–2 dias a média seria ruído puro. Antes disso: SEM_DECISAO.
   */
  diasMinObservados: 28,
} as const;

/** Grade fixa de quantis da calibração (spec §5.9 "Calibração"). */
export const GRADE_QUANTIS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.925, 0.95, 0.96, 0.97, 0.98, 0.985, 0.99, 0.995, 0.999] as const;
/**
 * Fallback do cold start (reposicao_cold_start_parametros: estoque_minimo 1, ponto_pedido 1, estoque_maximo 2,
 * estoque_seguranca 0): o parâmetro do SKU antes da 1ª sugestão OK. A 1ª sugestão OK o substitui (preencher/graduar).
 */
export const COLD_START = { es: 0, pp: 1, max: 2 } as const;

/**
 * R16: SKU cuja demanda vem mais de 10% via ficha técnica (insumo de v_sku_demanda_efetiva, que o motor usa e o extrato de
 * vendas não traz) sai da coorte: a demanda simulada dele estaria errada nas quatro fórmulas e no estoque.
 */
export const LIMITE_SHARE_INSUMO = 0.1;
