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
export interface TopProduto {
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
  /**
   * TODOS os SKUs do histórico lido, na mesma ordem do top. A ficha da ligação busca
   * aqui o último preço/data de cada SKU sugerido — o top 5 cortaria um SKU de recompra
   * que o cliente compra pouco.
   */
  produtos: TopProduto[];
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

  // Duas datas por SKU, em UMA passagem: a da ultima COMPRA (avanca com qualquer item) e a do
  // ultimo PRECO CONHECIDO (so avanca com item que tem preco). Antes era uma data so, e uma
  // compra sem preco vista PRIMEIRO empurrava `ultimaData` adiante e escondia o preco mais velho
  // que viesse depois — os mesmos itens davam 10, 20 ou null conforme a ordem da resposta.
  // "Nao sei agora" nao apaga "sabia antes", e nada aqui depende da ordem de `itens`.
  //
  // Empate de PRECO na mesma data (2 pedidos no dia, 2 linhas do SKU no pedido): vence o MAIOR.
  // O `precoUtilizavel` aceita 0 — uma linha bonificada no mesmo dia nao pode virar o "ultimo
  // preco" da ficha (o vendedor entraria na ligacao com R$ 0,00). Media ponderada fabricaria
  // um numero que nenhuma nota teve.
  // Empate de NOME na data da ultima compra: o menor na ordem de string (so para ser
  // deterministico — o hook resolve o nome pelo codigo, entao na pratica e um so). Duas grafias
  // do MESMO instante em `ultimaData` ('2026-06-01' × '2026-06-01T00:00:00Z'): a maior string.
  interface Acumulado {
    codigo: number; nome: string; vezes: number;
    ultimaData: string; ultimaMs: number;
    ultimoPreco: number | null; precoMs: number;
  }
  const porProduto = new Map<number, Acumulado>();
  for (const it of itens) {
    if (!naoFutura(it.dataPedido, hojeMs)) continue;
    const ms = new Date(it.dataPedido).getTime();
    const temPreco = it.precoUnit !== null;
    const atual = porProduto.get(it.codigo);
    if (!atual) {
      porProduto.set(it.codigo, {
        codigo: it.codigo, nome: it.nome, vezes: 1,
        ultimaData: it.dataPedido, ultimaMs: ms,
        ultimoPreco: it.precoUnit, precoMs: temPreco ? ms : -Infinity,
      });
      continue;
    }
    atual.vezes += 1;
    if (ms > atual.ultimaMs) {
      atual.ultimaMs = ms;
      atual.ultimaData = it.dataPedido;
      atual.nome = it.nome;
    } else if (ms === atual.ultimaMs) {
      if (it.nome < atual.nome) atual.nome = it.nome;
      if (it.dataPedido > atual.ultimaData) atual.ultimaData = it.dataPedido;
    }
    if (it.precoUnit !== null) {
      if (ms > atual.precoMs) {
        atual.precoMs = ms;
        atual.ultimoPreco = it.precoUnit;
      } else if (ms === atual.precoMs && it.precoUnit > (atual.ultimoPreco as number)) {
        atual.ultimoPreco = it.precoUnit;
      }
    }
  }

  const produtos: TopProduto[] = [...porProduto.values()]
    .sort((a, b) => b.vezes - a.vezes || b.ultimaMs - a.ultimaMs || a.codigo - b.codigo)
    .map(({ codigo, nome, vezes, ultimoPreco, ultimaData }) => ({ codigo, nome, vezes, ultimoPreco, ultimaData }));
  const topProdutos = produtos.slice(0, 5);

  // Pedidos na mesma data: maior valor primeiro, depois mais itens — a consulta ordena so por
  // data, e sem desempate o corte em 3 escolhia pela ordem da resposta.
  const ultimosPedidos = pedidos
    .filter((p) => naoFutura(p.data, hojeMs))
    .sort((a, b) =>
      new Date(b.data).getTime() - new Date(a.data).getTime() ||
      b.valor - a.valor ||
      b.nItens - a.nItens,
    )
    .slice(0, 3);

  return { topProdutos, produtos, ultimosPedidos };
}
