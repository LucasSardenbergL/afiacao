// O que o painel de detalhe do pedido SABE do desconto dos itens — a ponte entre a query de
// `order_items` (react-query) e a régua do cupom impresso (`resolverDescontoCupom`), que só conhece
// três leituras: lida, falhou, não se aplica.
//
// POR QUE NÃO BASTA `data ?? {}`: pedido sem linhas é "não há desconto", e afirmar isso sobre um
// pedido que ninguém conseguiu ler é a fabricação que a régua existe para impedir. Aqui a leitura que
// não aconteceu vira `falhou` — a tela fica a de hoje — e, quando a causa é erro ou falta de rede, o
// painel AVISA. `carregando` e `desabilitada` não avisam: a primeira se resolve sozinha, a segunda é a
// pergunta que não foi feita (`estado-de-leitura.ts`). Com cache em mãos e um refetch que falhou, a
// quebra do cache fica na tela e o aviso vai junto (`desatualizado`).
import {
  desatualizado,
  estadoDeLeitura,
  naoConsegui,
  type EstadoSemLeitura,
  type FatiaDeQuery,
} from '@/lib/leitura/estado-de-leitura';
import {
  leituraDoPedido,
  type LeituraDescontosItens,
  type LinhaDescontoItem,
} from '@/components/sales/print/descontoCupom';
import type { SalesOrder } from './types';

/** A fatia da query de `order_items` (`useDescontosItensPedido`) que o painel lê: estado + dado. */
export type FatiaDescontosItens = FatiaDeQuery & {
  data: Record<string, LinhaDescontoItem[]> | undefined;
};

export function descontosDoPainel(
  order: Pick<SalesOrder, 'id' | '_source'>,
  q: FatiaDescontosItens,
): { leitura: LeituraDescontosItens; falha: EstadoSemLeitura | null } {
  // Afiação (tabela `orders`) não tem order_items por desenho: nada a ler, nada a avisar.
  if (order._source === 'afiacao') return { leitura: { estado: 'nao-se-aplica' }, falha: null };
  if (q.data === undefined) {
    const estado = estadoDeLeitura(q);
    return { leitura: { estado: 'falhou' }, falha: naoConsegui(estado) ? estado : null };
  }
  const leitura = leituraDoPedido(q.data, order.id);
  const velho = desatualizado(q, true);
  // Dado em mãos que não cobre ESTE pedido: o desconto dele não foi lido, e a tela diz isso.
  return { leitura, falha: leitura.estado === 'falhou' ? (velho ?? 'erro') : velho };
}
