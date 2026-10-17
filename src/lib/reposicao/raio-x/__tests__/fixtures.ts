import type { DecisaoRow, FatoSku } from '../tipos';

export const HOJE = '2026-10-14';

export const fato = (o: Partial<FatoSku> = {}): FatoSku => ({
  sku_codigo_omie: 1, codigo: 'X1', descricao: 'PRODUTO', familia: 'Cola Branca', tipo_produto: '00', ativo: true,
  saldo: 10, cmc: 5, unidade_estoque: 'UN', unidades_venda: ['UN'], no_motor: false,
  tipo_reposicao: null, classe_abc: null, cadastro_em: '2026-04-01', ult_entrada: null, fornecedor: null,
  q12: 0, ncli: 0, ult_venda: null, preco_medio_12m: null, clientes: [], synced_at: null,
  habilitado_reposicao_automatica: null, ...o,
});

export const decisao = (sku: number, o: Partial<DecisaoRow> = {}): DecisaoRow => ({
  empresa: 'oben', sku_codigo_omie: sku, destino: null, observacao: null, fornecedor_informado: null,
  credito_troca: null, decidido_por: null, decidido_em: null, foto_saldo: null, foto_cmc: null, foto_valor: null,
  foto_categoria: null, foto_em: null, tirou_do_motor: false, motor_antes: null, qtd_contada: null,
  contado_por: null, contado_em: null, origem: 'app', atualizado_em: '2026-10-14T00:00:00Z', ...o,
});

export const mapaDecisoes = (...ds: DecisaoRow[]) => new Map(ds.map((d) => [d.sku_codigo_omie, d]));
