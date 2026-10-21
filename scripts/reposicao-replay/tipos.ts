// Tipos compartilhados do replay TSB (estoque de segurança Sayerlack). Datas = 'YYYY-MM-DD' (ISO, dia de São Paulo).
// Ausente é `null`, nunca 0 (money-path: ausente != zero).

export type Data = string;
export type Classe = 'A' | 'B' | 'C';

/** Erro de dados do replay. `message` começa pelo código: `CSV_INVALIDO:<arquivo>[: detalhe]`. */
export class ErroDadosReplay extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErroDadosReplay';
  }
}

export interface LinhaVenda {
  linhaId: string;
  sku: string;
  data: Data;
  /** Unidade de ESTOQUE (já convertida pelo contrato de unidade). Fora da coorte (noEscopo=false) fica CRUA e não deve ser usada. */
  quantidade: number;
  valor: number;
  /** CMC do último snapshot até a data da venda; null antes de 2026-01-15 (não existe CMC histórico). */
  cmcLinha: number | null;
  noEscopo: boolean;
}

/** Recebimento físico (chegada em t4) na unidade de ESTOQUE; alimenta a reconstrução do estoque inicial. */
export interface EventoRecebimento {
  sku: string;
  data: Data;
  quantidade: number;
}

export interface ItemLT {
  trackingId: string;
  sku: string;
  t1: Data;
  /** Faturamento (t2) do documento-SKU; null = ausente. Com t4, aproxima a identidade da NFe no LT do motor. */
  t2: Data | null;
  /** t4 do documento-SKU (1 recebimento por documento-SKU, ruling R7; sem checagem de >= 95% do pedido); null = aberto. */
  t4: Data | null;
  /** Dias úteis de t1 até t4; aberto: max(du de t1 até a extração, 15). */
  ltDu: number;
  aberto: boolean;
}

export interface Sku {
  sku: string;
  descricao: string;
  grupo: string | null;
  classeAbcHoje: Classe | null;
  classeForcada: Classe | null;
  minimoForcado: number | null;
  /** null = sem piso. */
  minimoOperacional: number | null;
  /** Múltiplo de compra (embalagem do fornecedor); null = sem arredondamento (a maioria dos SKUs). */
  multiplo: number | null;
  /** null = sem CMC hoje. */
  cmc: number | null;
  /** null = sem posição de estoque. */
  saldoHoje: number | null;
  ativo: boolean;
  habilitado: boolean;
  unidadeNf: string | null;
  unidadeEstoque: string | null;
  /** Fator cru do portal (sku_fornecedor_externo.fator_conversao); null = ausente. */
  fatorConversao: number | null;
  /** Grupo de embalagens equivalentes (sku_embalagem_equivalencia); null = fora de grupo. */
  grupoEmbalagemId: string | null;
  f0: { custoPedido: number; custoCapitalPerc: number };
  /** Parâmetros gravados hoje; null onde a coluna veio vazia. */
  hoje: { es: number | null; pp: number | null; max: number | null };
}

export interface TetoConfig {
  ativa: boolean;
  diasB: number;
  diasC: number;
}

export interface Equivalencia {
  sku: string;
  skuEquivalente: string;
  /** 1 unidade de `sku` = `fator` unidades do equivalente. */
  fator: number;
  grupoId: string;
  fatorParaBaseSku: number;
  fatorParaBaseEquivalente: number;
  unidadesOmieSku: number | null;
  unidadesOmieEquivalente: number | null;
}

export interface EstadoClassificacao {
  classeAtual: string;
  classeAbc: string;
  classeXyz: string;
  classePendente: string | null;
  mesesConsecutivos: number;
  dataUltimaMudanca: Data | null;
  valor: number | null;
}

export interface ClassificacaoHist {
  /** Parâmetros da regra (abc_corte_a_acumulado, meses_subir, ...), crus (texto). */
  regras: Record<string, string>;
  porSku: Map<string, EstadoClassificacao>;
}

export interface AvisoDados {
  codigo: string;
  n: number;
}

export interface Dados {
  vendas: LinhaVenda[];
  itensLT: ItemLT[];
  /** Chegadas (t4 não nulo, quantidade_recebida > 0) dos SKUs do contrato de unidade, ordenadas por (data, sku). */
  recebimentos: EventoRecebimento[];
  skus: Map<string, Sku>;
  zPorClasse: Record<Classe, number>;
  teto: TetoConfig;
  /** [] = arquivo válido sem equivalências; null = não carregado. */
  equivalencias: Equivalencia[] | null;
  sugestaoHoje: Map<string, { posicao: number; qtdeFinal: number }>;
  excluidos: { sku: string; motivo: string }[];
  classificacaoHist: ClassificacaoHist;
  /** R16: fração da demanda do SKU via ficha técnica (insumo), em [0, 1]; SKU ausente = sem demanda de insumo. */
  shareInsumo: Map<string, number>;
  /** Diagnósticos da carga (ex.: T4_ANTES_DE_T1; T1_FABRICADO = t1 igual a t2, fallback sem pedido casado, fora do LT; SEM_T4_REGISTRADO = documento sem t4 e com mais du que o LT máximo, fora da amostra de LT). */
  avisos: AvisoDados[];
  dataExtracao: Data;
  hashDados: string;
}

/** Padrão de demanda de Syntetos-Boylan (série semanal; ADI > 1,32; CV² > 0,49). `sem_dado` = menos de 2 semanas com venda. */
export type PadraoSB = 'suave' | 'erratico' | 'intermitente' | 'lumpy' | 'sem_dado';

/** SKU "parado" no corte da coorte (spec §5.1.1/§7): <= 1 semana com venda nas 27 semanas observadas antes do corte. */
export interface Parado {
  sku: string;
  semanasComVenda: number;
  ultimaVenda: Data | null;
  /** Última chegada física (recebimento, R9) antes do corte; null = nenhuma. */
  ultimaCompra: Data | null;
  /** saldoHoje x cmc de HOJE (não há estoque/CMC histórico no corte); null se qualquer um faltar. */
  estoqueCmc: number | null;
  habilitado: boolean;
  /** Houve recebimento físico nos 90 dias anteriores ao corte. */
  compradoUltimos90d: boolean;
  /** Classe efetiva no corte (R2); null = sem classe reconstruível. */
  classe: Classe | null;
}
