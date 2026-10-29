// Tipos compartilhados do replay TSB (estoque de segurança Sayerlack). Datas = 'YYYY-MM-DD' (ISO, dia de São Paulo).
// Ausente é `null`, nunca 0 (money-path: ausente != zero).
// Imports só de TIPO (apagados na compilação): sem ciclo em runtime com simulador/metricas.
import type { GradeCusto } from './metricas';
import type { Celula, Falta } from './simulador';

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
  /** t4 do recebimento que leva o acumulado a >= 95% do pedido (§5.9; ou o último, se encerrado no Omie); null = aberto. */
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
  /**
   * R19: v_sku_parametros_sugeridos (OBEN, Sayerlack) no INSTANTE da extração — a referência primária da paridade do F0.
   * SKU ausente = fora da view (sem venda em 90 d). es/pp/max null = status_sugestao <> 'OK'.
   */
  parametrosView: Map<string, { es: number | null; pp: number | null; max: number | null; status: string }>;
  /** Diagnósticos da carga (ex.: T4_ANTES_DE_T1; T1_FABRICADO; RECEBIMENTO_PARCIAL; CONVERSAO_INDETERMINADA; SEM_T4_ENCERRADO_OMIE; SEM_T4_STATUS_RECEBIDO; PARCIAL_ENCERRADO_OMIE; COPIAS_DO_DOCUMENTO_FUNDIDAS; DOCUMENTO_COM_LINHAS_DIVERGENTES; T4_DIVERGENTE_NO_DOCUMENTO), contados. */
  avisos: AvisoDados[];
  dataExtracao: Data;
  /**
   * Âncora do estado inicial (§5.9, achado 1): nSaldo do Omie no fim da véspera do aquecimento, por SKU
   * (`posicao_omie_<data>.csv`); null = arquivo ainda não extraído (a reconstrução cai no modo legado `saldo_hoje`).
   * nSaldo vazio fica fora do mapa (ausente ≠ 0).
   */
  posicaoAbertura: Map<string, number> | null;
  /** Posição do Omie no fim da calibração (30/04), só para CONFERÊNCIA da reconstrução; null = não extraída. */
  posicaoConferencia: Map<string, number> | null;
  /**
   * preco_compra_real do EOQ (achado 2): R$ por unidade recebida de cada DOCUMENTO coerente (as cópias concordam em
   * quantidade, valor e t4, como v_sku_leadtime_efetivo), conhecido a partir do dia seguinte a `desde` (= t4).
   * Ausente (fixture antiga) = sem preço de compra: a cadeia segue para a venda × 0,55, nunca 0.
   */
  precosCompra?: PrecoCompraDoc[];
  /** Preço-app dos membros de grupo de embalagem (achado 9). Ausente/null = sem preço: nunca troca de embalagem. */
  precosEmbalagem?: PrecosEmbalagem | null;
  /**
   * R40: a execução do motor que gerou `sugestaoHoje` (UTC) e a última passada de `sku_parametros` (UTC). A carga garante
   * que não houve passada entre as duas e que a execução é do mesmo dia de SP da extração. Ausente só em fixture sintética.
   */
  motor?: { horarioGeracao: string; ultimaPassada: string };
  /**
   * R43: amostra do LT do F0 = linhas de `v_sku_leadtime_efetivo` (produção) com `lt_bruto_dias_uteis` e t2, do escopo
   * OBEN Sayerlack e dos fornecedores dela; o filtro point-in-time (t4 < d, t2 na janela) é do formulas.ts. Ausente só em
   * fixture sintética (aí o F0 aproxima pelos itens de LT documentais, como antes).
   */
  ltMotor?: ObsLtMotorBruta[];
  /**
   * R45: CMC contábil do ERP (`nCMC` de ListarPosEstoque) nas posições datadas do Omie (20/10, 31/01, 30/04), por data
   * crescente; o capital usa a mais recente com data ≤ d. Ausente/vazio = sem posição extraída.
   */
  cmcOmie?: { data: Data; cmc: Map<string, number> }[];
  hashDados: string;
}

/** Linha de `v_sku_leadtime_efetivo` para o LT do F0 (R43): datas de SP; `fornecedor` = fornecedor_codigo_omie (null = sem). */
export interface ObsLtMotorBruta {
  sku: string;
  fornecedor: number | null;
  t2: Data;
  t4: Data;
  lt: number;
}

export interface PrecoCompraDoc {
  sku: string;
  /** t4 do documento (o maior entre as cópias); o preço vale para d > desde. */
  desde: Data;
  /** valor_total ÷ quantidade_recebida (R$ por unidade recebida). Absoluto: só em memória/$REPLAY_DADOS. */
  preco: number;
}

/** Capturas do preço-app (sku_preco_fornecedor_capturado) e a elegibilidade de catálogo dos membros de grupo. */
export interface PrecosEmbalagem {
  /** Janela de frescor do motor (embalagem_preco_motor_stale_dias, padrão 45). */
  staleDias: number;
  /** Elegibilidade de catálogo + portal (CTE membro_elegivel sem o preço) no estado de HOJE, por SKU membro. */
  elegivel: Map<string, boolean>;
  /** Capturas por SKU, data (dia de SP) crescente. */
  capturas: Map<string, { data: Data; preco: number }[]>;
}

/** Padrão de demanda de Syntetos-Boylan (série semanal; ADI > 1,32; CV² > 0,49). `sem_dado` = menos de 2 semanas com venda. */
export type PadraoSB = 'suave' | 'erratico' | 'intermitente' | 'lumpy' | 'sem_dado';

/** SKU "parado" no corte da coorte (spec §5.1.1/§7): <= 1 semana com venda nas 27 semanas observadas antes do corte. */
export interface Parado {
  sku: string;
  semanasComVenda: number;
  ultimaVenda: Data | null;
  /** Última chegada física (recebimento, dedup documental) antes do corte; null = nenhuma. */
  ultimaCompra: Data | null;
  /** saldoHoje x cmc de HOJE (não há estoque/CMC histórico no corte); null se qualquer um faltar. */
  estoqueCmc: number | null;
  habilitado: boolean;
  /** Houve recebimento físico nos 90 dias anteriores ao corte. */
  compradoUltimos90d: boolean;
  /** Classe efetiva no corte (R2); null = sem classe reconstruível. */
  classe: Classe | null;
}

// ── Evidência da tabela de decisão (spec §6.1; consumida por `estatistica.ts#avaliarCriterios`) ──────────────────

/** Tamanho do bloco do bootstrap, em semanas (spec §5.8: 4 e 8, sensibilidade). */
export type BlocoBootstrap = 4 | 8;

/** Ponto (amostra inteira) e limites unilaterais de 95% (quantis 5% e 95% do bootstrap). null = sem dado. */
export interface Intervalo {
  ponto: number | null;
  li: number | null;
  ls: number | null;
}

/** O mesmo indicador com blocos de 4 e de 8 semanas; a tabela usa LI = min(LI4, LI8) e LS = max(LS4, LS8). */
export type IntervaloPorBloco = Record<BlocoBootstrap, Intervalo>;

/** Critérios 1 e 2 num cenário de falta (fração; Δ = alternativa − F0). */
export interface EvidenciaServico {
  falta: Falta;
  /**
   * Piso por classe: fill rate da alternativa + as linhas para o Clopper-Pearson. `demandadas` = contagem OBSERVADA de
   * linhas da célula na janela (cada linha uma vez, NUNCA a soma sobre as reps); `atendidas` na mesma base (pode ser a
   * média das reps).
   */
  pisos: { classe: Classe; fill: IntervaloPorBloco; atendidas: number | null; demandadas: number | null }[];
  /** Não inferioridade nas 6 células (A, B, C, A_alt, B_alt, C_alt). */
  naoInferioridade: { celula: Celula; delta: IntervaloPorBloco }[];
}

/** Redução relativa do estoque médio contra F0 (fração: 0,10 = 10%). */
export interface EvidenciaCapital {
  falta: Falta;
  reducao: IntervaloPorBloco;
  /** Achado 10: fração das unidades × dias de estoque sem CMC na janela, por braço (null = sem unidade). Só informa o motivo. */
  naoValorado?: { f0: number | null; alt: number | null };
}

/** Critério 5 numa célula da grade × cenário de falta. Custo em R$ (positivo = alternativa vantajosa). */
export interface EvidenciaEconomia {
  falta: Falta;
  grade: GradeCusto;
  custo: IntervaloPorBloco;
  /** Achado 11: linhas/valor de canceladas sem cmc (margem desconhecida) nos dois braços; > 0 ⇒ custo null (INCERTO). */
  linhasMargemDesconhecida: number;
  valorMargemDesconhecida: number;
  /** Denominadores para mostrar o limite em % (nunca R$ absoluto no relatório). */
  linhasDemandadas: number | null;
  valorDemandado: number | null;
}

export type VereditoReplay = 'GO' | 'NO-GO' | 'INCONCLUSIVO';

/** Tudo o que a tabela §6.1 lê. Listas vazias ou campos null viram INCERTO (sem dado ≠ aprovado). */
export interface Evidencia {
  /** Critérios 1 e 2: obrigatórios os dois extremos de falta (`CENARIOS_FALTA.servico`). */
  servico: EvidenciaServico[];
  /** Critério 3: obrigatórios os cenários de `CENARIOS_FALTA.economia` (R25). */
  capital: EvidenciaCapital[];
  /** Critério 4: LT `max(LT,15)`, serviço como em 1 e 2 e redução de capital (capital nos cenários da economia, R25). */
  estresse: { servico: EvidenciaServico[]; capital: EvidenciaCapital[] };
  /**
   * Critério 5: toda a grade na taxa base em cada cenário de `CENARIOS_FALTA.economia`. Taxas de 20%/30% = só
   * sensibilidade (R26), não são gate.
   */
  economia: EvidenciaEconomia[];
  /** Linhas da avaliação por célula de 1 e 2 (null = não medido). */
  exposicao: { celula: Celula; linhas: number | null }[];
  /** Meia largura MC (fração) com as replicações usadas; null = não medida. */
  precisao: {
    replicacoes: number;
    teto: number;
    meiaLarguraServico: number | null;
    alvoServico: number;
    meiaLarguraEstoque: number | null;
    alvoEstoque: number;
  };
  /**
   * Veredito em cada estado inicial plausível (§5.2: reconstruido+ajuste, piso_zero), cada um calculado SEM esta linha.
   * null = não avaliado.
   */
  estadosIniciais: { rotulo: string; veredito: VereditoReplay | null }[] | null;
}
