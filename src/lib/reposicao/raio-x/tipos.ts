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
  top: boolean;
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
}
