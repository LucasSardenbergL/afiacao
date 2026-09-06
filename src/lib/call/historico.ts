export interface HistoricoItemInput {
  codigo: number;
  nome: string;
  quantidade: number;
  /** `null` = preco NAO SABIDO (o Omie nao informou). Nunca 0 fabricado. */
  precoUnit: number | null;
  dataPedido: string; // ISO — data de negócio do pedido (order_date_kpi)
}
export interface HistoricoPedidoInput {
  data: string; // ISO
  valor: number;
  nItens: number;
}
export interface HistoricoInput {
  itens: HistoricoItemInput[];
  pedidos: HistoricoPedidoInput[];
  agora: Date;
}
interface TopProduto {
  codigo: number;
  nome: string;
  vezes: number;
  /** Ultimo preco CONHECIDO do SKU. `null` = nenhuma compra dele tinha preco. */
  ultimoPreco: number | null;
  ultimaData: string;
}
interface PedidoResumo {
  data: string;
  valor: number;
  nItens: number;
}
export interface Historico {
  topProdutos: TopProduto[];
  ultimosPedidos: PedidoResumo[];
}

const naoFutura = (iso: string, hojeMs: number): boolean => {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t <= hojeMs;
};

/**
 * Derivação pura da ficha pré-contato. Recebe itens JÁ filtrados por pedido
 * válido (o hook exclui status inválidos). Ignora datas futuras (Omie adianta
 * order_date_kpi). Sem dados → listas vazias (nunca fabrica).
 */
export function derivarHistorico({ itens, pedidos, agora }: HistoricoInput): Historico {
  const hojeMs = agora.getTime();

  const porProduto = new Map<number, TopProduto>();
  for (const it of itens) {
    if (!naoFutura(it.dataPedido, hojeMs)) continue;
    const atual = porProduto.get(it.codigo);
    if (!atual) {
      porProduto.set(it.codigo, {
        codigo: it.codigo, nome: it.nome, vezes: 1,
        ultimoPreco: it.precoUnit, ultimaData: it.dataPedido,
      });
    } else {
      atual.vezes += 1;
      if (new Date(it.dataPedido).getTime() > new Date(atual.ultimaData).getTime()) {
        atual.ultimaData = it.dataPedido;
        // A DATA avanca sempre (a compra existiu), mas o PRECO so e sobrescrito por um preco
        // que se conhece. Antes, uma compra recente sem preco apagava o ultimo preco praticado
        // e a ficha de pre-contato mostrava R$ 0,00 — o vendedor entrava na ligacao com um
        // numero que ninguem praticou. "Nao sei agora" nao apaga "sabia antes".
        if (it.precoUnit !== null) atual.ultimoPreco = it.precoUnit;
        atual.nome = it.nome;
      }
    }
  }

  const topProdutos = [...porProduto.values()]
    .sort((a, b) =>
      b.vezes - a.vezes ||
      new Date(b.ultimaData).getTime() - new Date(a.ultimaData).getTime(),
    )
    .slice(0, 5);

  const ultimosPedidos = pedidos
    .filter((p) => naoFutura(p.data, hojeMs))
    .sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime())
    .slice(0, 3);

  return { topProdutos, ultimosPedidos };
}
