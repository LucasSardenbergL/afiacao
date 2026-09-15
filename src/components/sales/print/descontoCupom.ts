// Desconto de ITEM no cupom impresso — decide se a quebra (coluna Desconto + "Subtotal bruto −
// Desconto = TOTAL") vai para o papel, a partir de `order_items.desconto_valor`.
//
// POR QUE EXISTE: o cupom monta as linhas do jsonb `sales_orders.items`, que é BRUTO — a chave legado
// `desconto` do jsonb é sempre 0 e não pode mudar sozinha, porque a trigger de coerência do agregado
// a compara com `order_items.discount`. Desde o #2469 o cabeçalho (`subtotal`/`total`) é LÍQUIDO:
// no pedido real oben 12183048572 as linhas somavam 1.629,25 sob um TOTAL de 1.489,34, sem nada no
// papel que explicasse os R$ 139,91. O desconto de cada linha só existe em order_items.
//
// A RÉGUA (decisões do founder, 2026-09-14):
//   1. A quebra só sai quando FECHA: Subtotal bruto − Desconto = TOTAL gravado, em CENTAVOS — a conta
//      que o cliente faz no papel. Não fechou (cabeçalho ainda bruto porque o deploy/reprocess do
//      #2469 não o alcançou, desconto sem par no jsonb, item sem preço) → o cupom sai COMO HOJE e a
//      equipe recebe um aviso. Nunca vai ao papel uma conta que não fecha.
//      A conferência é exata em centavos, não "½ centavo por linha": o edge arredonda o total UMA vez,
//      então Σ bruto − Σ desconto já cai no centavo do total; folga por linha aceitaria, num pedido de
//      40 linhas, um cabeçalho BRUTO com R$ 0,15 de desconto e imprimiria uma conta errada.
//   2. Sem desconto a explicar (nenhuma linha apurada, desconto zero, pedido sem order_items) → como
//      hoje, sem aviso. Zero apurado não muda o cupom de ninguém.
//   3. Linha não apurada (desconto_valor NULL) no meio de apuradas sai "—", nunca R$ 0,00.
//   4. Leitura de order_items que FALHOU → como hoje, COM aviso: "não consegui ler" não é "não há".
import { formatPrecoOuAusente } from '@/lib/format';
import { finitoNaoNegativo } from '@/lib/pedido/desconto-item';

/** Linha de `order_items` com o que o cupom precisa para casar com o jsonb e descontar. */
export interface LinhaDescontoItem {
  omie_codigo_produto: number | null;
  quantity: number | null;
  unit_price: number | null;
  /** R$ da LINHA inteira. `null` = não apurado — diferente de 0 ("o Omie informou que não há"). */
  desconto_valor: number | null;
}

/** O que se sabe do order_items de UM pedido na hora de imprimir. */
export type LeituraDescontosItens =
  | { estado: 'lida'; linhas: LinhaDescontoItem[] }
  /** a leitura não aconteceu (erro, sem rede, ainda carregando) — NÃO é "sem desconto" */
  | { estado: 'falhou' }
  /** pedido que não tem order_items por desenho (afiação, tabela `orders`) */
  | { estado: 'nao-se-aplica' };

type DescontoDoCupom =
  | { quebra: false; aviso: string | null }
  | {
      quebra: true;
      /** desconto de cada item do jsonb, na MESMA ordem dos itens; `null` = não apurado ("—") */
      descontoPorItem: Array<number | null>;
      subtotalBruto: number;
      descontoTotal: number;
      itensApurados: number;
    };

/** Item do jsonb `sales_orders.items` — só o que identifica a linha. */
interface ItemDoCupom {
  omie_codigo_produto?: unknown;
  quantidade?: unknown;
  valor_unitario?: unknown;
}

const AVISO_LEITURA_FALHOU =
  'não foi possível ler o desconto dos itens — o cupom saiu sem a coluna de desconto. Tente imprimir de novo.';

const centavos = (valor: number) => Math.round(valor * 100);

// Soma só o que conhece: a linha não apurada fica FORA da soma, nunca entra como 0.
const somarConhecidos = (valores: Array<number | null>) =>
  valores.reduce<number>((acc, v) => (v === null ? acc : acc + v), 0);

// Identidade da linha: (produto, quantidade, preço) — a mesma que a trigger de coerência do agregado
// usa para exigir que jsonb e order_items descrevam os mesmos itens. Sem os três, não há como casar.
function chaveDaLinha(produto: unknown, quantidade: unknown, preco: unknown): string | null {
  const p = finitoNaoNegativo(produto);
  const q = finitoNaoNegativo(quantidade);
  const u = finitoNaoNegativo(preco);
  return p === null || q === null || u === null ? null : `${p}|${q}|${u}`;
}

function casarDescontos(itens: ReadonlyArray<ItemDoCupom>, linhas: ReadonlyArray<LinhaDescontoItem>): Array<number | null> {
  const porChave = new Map<string, Array<number | null>>();
  for (const linha of linhas) {
    const chave = chaveDaLinha(linha.omie_codigo_produto, linha.quantity, linha.unit_price);
    if (chave === null) continue;
    const grupo = porChave.get(chave);
    const desconto = finitoNaoNegativo(linha.desconto_valor);
    if (grupo) grupo.push(desconto);
    else porChave.set(chave, [desconto]);
  }
  const consumidas = new Map<string, number>();
  return itens.map((item) => {
    const chave = chaveDaLinha(item.omie_codigo_produto, item.quantidade, item.valor_unitario);
    const grupo = chave === null ? undefined : porChave.get(chave);
    if (chave === null || !grupo) return null;
    // Linhas indistinguíveis (mesmo produto, quantidade e preço — p.ex. duas cores da mesma base)
    // com descontos DIFERENTES: não há como saber qual item do papel levou qual. Nenhum leva.
    if (grupo.some((d) => d !== grupo[0])) return null;
    const usadas = consumidas.get(chave) ?? 0;
    if (usadas >= grupo.length) return null;
    consumidas.set(chave, usadas + 1);
    return grupo[0];
  });
}

export function resolverDescontoCupom(
  itens: ReadonlyArray<ItemDoCupom>,
  leitura: LeituraDescontosItens,
  totalGravado: number | null | undefined,
): DescontoDoCupom {
  if (leitura.estado === 'nao-se-aplica') return { quebra: false, aviso: null };
  if (leitura.estado === 'falhou') return { quebra: false, aviso: AVISO_LEITURA_FALHOU };

  // O desconto que o pedido TEM, medido nas linhas — casem ou não com o papel. É contra ele que se
  // confere o que foi casado: desconto que não achou item não pode sumir em silêncio.
  const apurado = centavos(somarConhecidos(leitura.linhas.map((l) => finitoNaoNegativo(l.desconto_valor))));
  if (apurado === 0) return { quebra: false, aviso: null };

  const descontoPorItem = casarDescontos(itens, leitura.linhas);
  const desconto = centavos(somarConhecidos(descontoPorItem));
  const brutos = itens.map((item) => {
    const q = finitoNaoNegativo(item.quantidade);
    const u = finitoNaoNegativo(item.valor_unitario);
    return q === null || u === null ? null : q * u;
  });
  const bruto = brutos.includes(null) ? null : centavos(somarConhecidos(brutos));
  const total = finitoNaoNegativo(totalGravado);

  const fecha = desconto === apurado && bruto !== null && total !== null && bruto - desconto === centavos(total);
  if (!fecha || bruto === null) {
    return {
      quebra: false,
      aviso:
        `o desconto apurado dos itens (${formatPrecoOuAusente(apurado / 100)}) não fecha com o total gravado ` +
        `(${formatPrecoOuAusente(total)}) — o cupom saiu sem a coluna de desconto.`,
    };
  }
  return {
    quebra: true,
    descontoPorItem,
    subtotalBruto: bruto / 100,
    descontoTotal: desconto / 100,
    itensApurados: descontoPorItem.filter((d) => d !== null).length,
  };
}

/**
 * A leitura de UM pedido dentro de uma leitura em LOTE. Pedido que o lote não cobriu — lote ainda
 * carregando, que falhou, ou de outra janela — é `falhou`, nunca `lida` vazia: lista vazia afirmaria
 * "não há desconto" sobre um pedido que ninguém leu.
 */
export function leituraDoPedido(
  porPedido: Record<string, LinhaDescontoItem[]> | undefined,
  pedidoId: string,
): LeituraDescontosItens {
  if (!porPedido || !Object.prototype.hasOwnProperty.call(porPedido, pedidoId)) return { estado: 'falhou' };
  return { estado: 'lida', linhas: porPedido[pedidoId] };
}

const AVISOS_NA_DESCRICAO = 5;

/**
 * Texto do toast da EQUIPE quando um ou mais cupons saem sem a quebra de desconto; `null` quando
 * nenhum avisou. O aviso nunca vai ao papel — quem imprime o mostra na tela. Num lote grande, a
 * descrição mostra os primeiros e conta o resto, para o toast não cobrir a tela.
 */
export function mensagemAvisoDesconto(
  avisos: ReadonlyArray<string | null | undefined>,
): { titulo: string; descricao: string } | null {
  const presentes = avisos.filter((aviso): aviso is string => typeof aviso === 'string' && aviso !== '');
  if (presentes.length === 0) return null;
  const titulo =
    presentes.length === 1
      ? 'Cupom impresso sem a coluna de desconto'
      : `${presentes.length} cupons impressos sem a coluna de desconto`;
  const linhas = presentes.slice(0, AVISOS_NA_DESCRICAO);
  const excedente = presentes.length - linhas.length;
  if (excedente > 0) linhas.push(`… e mais ${excedente}`);
  return { titulo, descricao: linhas.join('\n') };
}
