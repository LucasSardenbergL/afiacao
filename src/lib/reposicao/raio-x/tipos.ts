// Tipos do Raio-X do estoque parado (fase B). snake_case idêntico ao retorno das RPCs
// `raio_x_estoque_fatos` / `raio_x_medicao` — sem camada de mapeamento. Escritos à mão porque o gerador
// de tipos do Supabase declara tudo não-nulo; aqui `| null` marca o que de fato pode vir nulo.
// Colacor: q12/ncli/ult_venda/clientes/unidades_venda vêm NULL (sem venda por NF). Oben: q12 = 0 é zero COMPROVADO.

export type Empresa = 'oben' | 'colacor';
export type Categoria = 'nao_mercadoria' | 'uso_consumo' | 'mercadoria';
export type Destino =
  | 'trocar'
  | 'venda_dirigida'
  | 'liquidar'
  | 'manter_suspender_recompra'
  | 'estrategico'
  | 'erro_cadastro';
export type Sugestao = Destino | 'novo_aguarde' | 'revisar' | 'sem_historico';
/** Canal de liquidação (CHECK de `raio_x_decisao.canal_liquidacao`). */
export type CanalLiquidacao = 'cliente_especifico' | 'promocao_carteira' | 'outlet_queima' | 'outro';
/** Contrapartida da troca (CHECK de `raio_x_decisao.troca_contrapartida`): o que entra no lugar. Encalhe não libera nada. */
export type TrocaContrapartida = 'giro' | 'encalhe';
/**
 * Linha de `raio_x_inequivoco(p_empresa)`. A regra do "liquidar só o inequívoco" é do SERVIDOR (o decidir recusa
 * com RX004); aqui só se exibe. `inequivoco=false` traz TODOS os motivos que seguram (nunca só o primeiro).
 */
export interface InequivocoSku {
  sku_codigo_omie: number;
  inequivoco: boolean;
  motivos_espera: string[];
  cobertura_dias: number | null;
  /** saldo − 90 dias de consumo; null quando não é inequívoco. */
  qtd_liquidavel: number | null;
  ultima_entrada: string | null;
  revisar_em: string | null;
}

export interface ClienteComprador {
  nome: string;
  ult: string | null;
  qtd: number;
}

export interface ClassificacaoManual {
  categoria: Categoria;
  motivo: string;
}

/** Linha de `raio_x_estoque_fatos(p_empresa)`, na ordem do RETURNS TABLE. */
export interface FatoSku {
  sku_codigo_omie: number;
  codigo: string;
  descricao: string | null;
  familia: string | null;
  tipo_produto: string | null;
  ativo: boolean;
  saldo: number;
  cmc: number | null;
  unidade_estoque: string | null;
  unidades_venda: string[] | null;
  no_motor: boolean;
  tipo_reposicao: string | null;
  classe_abc: string | null;
  cadastro_em: string | null;
  ult_entrada: string | null;
  fornecedor: string | null;
  q12: number | null;
  ncli: number | null;
  ult_venda: string | null;
  preco_medio_12m: number | null;
  clientes: ClienteComprador[] | null;
  synced_at: string | null;
  habilitado_reposicao_automatica: boolean | null;
}

export interface ItemRaioX extends FatoSku {
  valor: number | null;
  cobertura: number | null;
  categoria: Categoria;
  motivo_categoria: string;
  parado: boolean;
  destino_sugerido: Sugestao | null;
  motivo_destino: string;
  /** Item parado com entrada < 90 dias: recompra recente de item parado (alerta, não imunidade). */
  alerta_recompra: string | null;
  /** Na coorte da meta (congelada); sem coorte congelada, = `top_atual`. */
  top: boolean;
  /** No Top 61 recalculado hoje. */
  top_atual: boolean;
  /** Entraria no Top hoje, mas não está na coorte congelada: aparece, não mexe no denominador. */
  entrou_no_top: boolean;
  /** Veredito do servidor (`raio_x_inequivoco`); null = leitura indisponível (nunca "inequívoco" por omissão). */
  inequivoco: boolean | null;
  motivos_espera: string[];
  qtd_liquidavel: number | null;
  ultima_entrada: string | null;
}

/** Linha de `raio_x_coorte_top`: valor congelado pelo SERVIDOR (saldo × cmc no congelamento; null = sem custo). */
interface MembroCoorte {
  posicao: number;
  valor: number | null;
}

/** Coorte do Top 61 congelada uma vez por empresa — o denominador da meta. */
export interface CoorteTop {
  congelada_em: string;
  itens: Map<number, MembroCoorte>;
}

/** Linha da tabela `raio_x_decisao`. */
export interface DecisaoRow {
  empresa: Empresa;
  sku_codigo_omie: number;
  destino: Destino | null;
  observacao: string | null;
  fornecedor_informado: string | null;
  credito_troca: number | null;
  decidido_por: string | null;
  decidido_em: string | null;
  foto_saldo: number | null;
  foto_cmc: number | null;
  foto_valor: number | null;
  foto_categoria: string | null;
  foto_em: string | null;
  tirou_do_motor: boolean;
  motor_antes: unknown;
  qtd_contada: number | null;
  contado_por: string | null;
  contado_em: string | null;
  origem: 'app' | 'artifact_fase_a';
  atualizado_em: string;
  // Plano de execução (pacote 2; escritor único `raio_x_planejar`). Re-decidir não apaga: a leitura filtra
  // (piso/canal só com destino liquidar; concluido_em < decidido_em = destino mudou depois).
  /** R$ por unidade de VENDA. */
  preco_piso: number | null;
  canal_liquidacao: CanalLiquidacao | null;
  responsavel: string | null;
  /** 'YYYY-MM-DD' */
  prazo: string | null;
  concluido_em: string | null;
  concluido_por: string | null;
  // PR 2 (inequívoco): frete do liquidar, desconto COMERCIAL sobre o médio 12m e margem por unidade com as bases
  // CONGELADAS ao planejar; contrapartida da troca. `?? null` na borda (bundle pode ir ao ar antes da migration).
  frete_estimado: number | null;
  desconto_sobre_medio_pct: number | null;
  margem_unit: number | null;
  preco_medio_base: number | null;
  cmc_base: number | null;
  troca_contrapartida: TrocaContrapartida | null;
}

/**
 * Linha de `raio_x_medicao(p_empresa)`.
 * Colacor: qtd_vendida/receita/preco_medio_12m NULL (sem NF). `compras_apos` NULL = leitor sem
 * permissão de compras (ou colacor) — NÃO significa "nenhuma recompra" (isso seria `[]`).
 */
export interface LinhaMedicao {
  sku_codigo_omie: number;
  destino: Destino;
  decidido_em: string | null;
  foto_saldo: number | null;
  foto_cmc: number | null;
  foto_valor: number | null;
  foto_categoria: string | null;
  credito_troca: number | null;
  saldo_atual: number | null;
  qtd_vendida: number | null;
  receita: number | null;
  preco_medio_12m: number | null;
  compras_apos: string[] | null;
  troca_contrapartida: TrocaContrapartida | null;
}
