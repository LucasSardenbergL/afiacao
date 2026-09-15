// Mensagem de WhatsApp de um pedido de venda da listagem — o desconto de ITEM com a MESMA régua do
// cupom impresso (`resolverDescontoCupom`), sem cópia.
//
// POR QUE EXISTE: a mensagem listava cada item como quantidade × preço do jsonb `sales_orders.items`,
// que é BRUTO, sob o "Total" do cabeçalho, que desde o #2469 é LÍQUIDO. No pedido real oben
// 12183048572 o CLIENTE recebia linhas somando 1.629,25 sob um Total de 1.489,34, sem nada que
// explicasse os R$ 139,91.
//
// A RÉGUA é a do cupom (docs/historico/cupom-desconto-por-item.md): a quebra só entra quando Subtotal
// bruto − Desconto fecha com o Total em centavos. Aí cada linha vai LÍQUIDA (`receitaLiquidaItem`;
// `null` → "—" quando o desconto da linha não foi apurado) e a mensagem ganha Subtotal/Desconto com os
// rótulos do cupom (decisão do founder, 2026-09-14). Sem a quebra, a mensagem de sempre: os itens
// saem SEM a chave `lineTotal`, e o share faz quantidade × preço como antes.
//
// FRONTEIRA: não importa `@/utils/whatsappShare` (módulo telefonia-whatsapp-rota). Devolve os valores
// prontos; quem chama (useSalesOrders) os entrega ao `shareOrderViaWhatsApp`.
import { resolverDescontoCupom, type LeituraDescontosItens } from '@/components/sales/print/descontoCupom';
import { receitaLiquidaItem } from '@/lib/pedido/desconto-item';
import type { SalesOrder } from './types';

interface ItemDaMensagem {
  description: string;
  quantity: number;
  unitPrice: number | null;
  /** Só com a quebra: o LÍQUIDO da linha; `null` = desconto da linha não apurado ("—"). */
  lineTotal?: number | null;
}

interface CompartilhamentoDoPedido {
  items: ItemDaMensagem[];
  /** Só quando a conta fecha: o share escreve Subtotal e Desconto antes do Total. */
  quebraDesconto?: { subtotalBruto: number; descontoTotal: number; itensApurados: number };
  /** Aviso da EQUIPE (toast) — nunca vai na mensagem. */
  aviso: { titulo: string; descricao: string } | null;
}

const TITULO_AVISO = 'Mensagem do WhatsApp sem as linhas de desconto';

// O aviso da régua é escrito para o CUPOM: "<causa> — o cupom saiu sem a coluna de desconto[. Tente
// imprimir de novo.]". A causa (com os dois valores, quando a conta não fecha) vale para os dois
// canais; a consequência aqui é a da mensagem. O teste reprova se o texto voltar a citar o cupom.
function avisoDaMensagem(avisoDaRegua: string | null, leitura: LeituraDescontosItens): CompartilhamentoDoPedido['aviso'] {
  if (avisoDaRegua === null) return null;
  const causa = avisoDaRegua.split(' — ')[0];
  const tenteDeNovo = leitura.estado === 'falhou' ? ' Tente compartilhar de novo.' : '';
  return { titulo: TITULO_AVISO, descricao: `${causa} — a mensagem saiu sem as linhas de desconto.${tenteDeNovo}` };
}

export function montarCompartilhamento(
  order: { items: SalesOrder['items'] | null | undefined; total: number | null | undefined },
  descontos: LeituraDescontosItens,
): CompartilhamentoDoPedido {
  const itens = order.items ?? [];
  const decisao = resolverDescontoCupom(itens, descontos, order.total);
  const descontoPorItem = decisao.quebra ? decisao.descontoPorItem : null;
  const items = itens.map((item, i) => ({
    description: item.descricao,
    quantity: item.quantidade,
    unitPrice: item.valor_unitario,
    ...(descontoPorItem ? { lineTotal: receitaLiquidaItem(item.valor_unitario, item.quantidade, descontoPorItem[i]) } : {}),
  }));
  if (decisao.quebra) {
    const { subtotalBruto, descontoTotal, itensApurados } = decisao;
    return { items, quebraDesconto: { subtotalBruto, descontoTotal, itensApurados }, aviso: null };
  }
  return { items, aviso: avisoDaMensagem(decisao.aviso, descontos) };
}
