/**
 * C6 (rodada 2): a busca de produto filtra o catálogo JÁ carregado. Quando o catálogo não veio,
 * a lista saía vazia — e "não consegui buscar" parecia "esse produto não existe". São estados
 * que pedem ações opostas (tentar de novo × mudar o termo), então a tela os separa.
 */
export type EstadoListaProdutos = 'carregando' | 'falhou' | 'sem_resultado' | 'catalogo_vazio' | 'lista';

export interface EntradaEstadoCatalogo {
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  temDados: boolean;
}

/** Estado do catálogo de uma conta, a partir da query. Erro COM dado em mãos não é falha: a lista vale. */
export function estadoDoCatalogo(q: EntradaEstadoCatalogo): 'carregando' | 'falhou' | 'ok' {
  if (q.temDados) return 'ok';
  if (q.isPending) return 'carregando';
  if (q.isError) return q.isFetching ? 'carregando' : 'falhou';
  return 'ok';
}

export function estadoListaProdutos(e: {
  catalogo: 'carregando' | 'falhou' | 'ok';
  quantidade: number;
  termo: string;
}): EstadoListaProdutos {
  if (e.catalogo !== 'ok') return e.catalogo;
  if (e.quantidade > 0) return 'lista';
  return e.termo.trim() ? 'sem_resultado' : 'catalogo_vazio';
}
