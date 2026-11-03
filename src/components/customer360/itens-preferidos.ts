// "Itens preferidos" do Customer 360, derivados dos PEDIDOS DE VENDA do cliente (`sales_orders`).
//
// Antes saíam de `customer_preferred_items`, cujo único escritor era a action
// `historico_produtos_cliente` da omie-vendas-sync — chamada só pela tela de pedido, que deixou de
// chamá-la em 06/06 (#682). A tabela congelou em 08/06 e o card seguiu mostrando o retrato velho como
// se fosse atual. Agora a fonte é a mesma que alimenta o "já comprou" da tela de pedido: o espelho
// local dos pedidos, que o `sync_pedidos` mantém.
//
// Todo item gravado pelo sync traz `omie_codigo_produto` e `descricao` (medido 2026-11-02: 73.071 de
// 73.071). Item sem código Omie válido não entra — não há como chaveá-lo nem casá-lo com o catálogo.

/** Janela, em dias, contada sobre `order_date_kpi` — a mesma régua do "Faturamento 12m" ao lado. */
export const JANELA_PREFERIDOS_DIAS = 365;
const LIMITE_PREFERIDOS = 10;

export interface PedidoParaPreferidos {
  account: string | null;
  order_date_kpi: string | null;
  items: unknown;
}

export interface ProdutoCatalogo {
  account: string;
  omie_codigo_produto: number;
  codigo: string | null;
  familia: string | null;
}

export interface PreferredItem {
  product_codigo: string | null;
  product_descricao: string | null;
  familia: string | null;
  order_count: number;
  last_ordered_at: string | null;
  account: string | null;
  omie_codigo_produto: number;
}

const chave = (account: string | null, omie: number) => `${account ?? ''}::${omie}`;

function codigoOmie(item: unknown): number | null {
  if (item === null || typeof item !== 'object') return null;
  const bruto = (item as Record<string, unknown>).omie_codigo_produto;
  const n = typeof bruto === 'number' ? bruto : typeof bruto === 'string' && /^\d+$/.test(bruto) ? Number(bruto) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function descricao(item: unknown): string | null {
  const d = (item as Record<string, unknown>).descricao;
  return typeof d === 'string' && d.trim() !== '' ? d : null;
}

/**
 * Agrega por (conta, produto Omie): em quantos PEDIDOS distintos o produto aparece e a data do mais
 * recente. Ordena por frequência e, no empate, pelo mais recente. A descrição é a do pedido mais
 * recente (o nome do produto pode ter mudado no Omie).
 */
export function agregarItensPreferidos(
  pedidos: PedidoParaPreferidos[],
  limite = LIMITE_PREFERIDOS,
): Omit<PreferredItem, 'product_codigo' | 'familia'>[] {
  const porChave = new Map<string, Omit<PreferredItem, 'product_codigo' | 'familia'>>();
  for (const pedido of pedidos) {
    if (!Array.isArray(pedido.items)) continue;
    const vistosNestePedido = new Set<string>();
    for (const item of pedido.items) {
      const omie = codigoOmie(item);
      if (omie === null) continue;
      const k = chave(pedido.account, omie);
      if (vistosNestePedido.has(k)) continue;
      vistosNestePedido.add(k);
      const atual = porChave.get(k);
      if (!atual) {
        porChave.set(k, {
          omie_codigo_produto: omie,
          account: pedido.account,
          product_descricao: descricao(item),
          order_count: 1,
          last_ordered_at: pedido.order_date_kpi,
        });
        continue;
      }
      atual.order_count += 1;
      if (pedido.order_date_kpi && (!atual.last_ordered_at || pedido.order_date_kpi > atual.last_ordered_at)) {
        atual.last_ordered_at = pedido.order_date_kpi;
        atual.product_descricao = descricao(item) ?? atual.product_descricao;
      }
    }
  }
  return [...porChave.values()]
    .sort((a, b) =>
      b.order_count - a.order_count
      || (b.last_ordered_at ?? '').localeCompare(a.last_ordered_at ?? ''))
    .slice(0, limite);
}

/** Completa código e família pelo catálogo, casando o PAR (conta, produto) — o código Omie colide entre contas. */
export function completarComCatalogo(
  itens: Omit<PreferredItem, 'product_codigo' | 'familia'>[],
  catalogo: ProdutoCatalogo[],
): PreferredItem[] {
  const porChave = new Map(catalogo.map((p) => [chave(p.account, p.omie_codigo_produto), p]));
  return itens.map((it) => {
    const p = porChave.get(chave(it.account, it.omie_codigo_produto));
    return { ...it, product_codigo: p?.codigo ?? null, familia: p?.familia ?? null };
  });
}
