// Constantes do replay TSB (spec 2026-10-20-tsb-estoque-seguranca-design.md §5.9 e plano, Global Constraints).
import type { Classe, Data } from './tipos';

export const CORTE_COORTE: Data = '2026-05-01';

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
  misto: { espera: 0.6, cancelamento: 0.3, outro: 0.1 },
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
  'equivalencias',
  'recebimentos',
  'skus',
  'sugestao_hoje',
  'teto',
  'vendas',
] as const;
