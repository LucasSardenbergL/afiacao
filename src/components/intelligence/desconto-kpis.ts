// KPIs de desconto da aba estratégica — com degradação HONESTA.
//
// Fonte: `order_items.desconto_valor` (R$ da LINHA; régua em supabase/functions/_shared/desconto-omie.ts).
// As colunas legadas `sales_orders.discount` e `order_items.discount` são 0 em 100% das linhas (o
// leitor antigo lia `prod.desconto`, chave que a API do Omie não tem; a capa é 0 POR DESENHO — o Omie
// distribui o desconto de capa aos itens). Lidas, elas fabricavam "Sensibilidade a Desconto 0%" e
// "Elasticidade −100%".
//
// Três estados por item, e eles NÃO colapsam:
//   > 0                        → com desconto
//   = 0                        → sem desconto (o Omie informou zero — agora é FATO, não ausência)
//   null/NaN/negativo/ausente  → desconhecido (não apurado): fica FORA do numerador E do denominador
// Pedido: com desconto se algum item tem; sem desconto só se TODOS os itens foram apurados = 0; o
// resto (item desconhecido sem nenhum com desconto, ou pedido sem itens) é desconhecido.
// Medido em 2026-10-14: 1.664 itens > 0, 12.551 = 0 e 58.100 NULL — quase todos os NULL são
// anteriores a 2025-07; a amostra recente é quase toda apurada.
//
// Sem nenhum pedido/item APURADO na amostra, o KPI é `null` ("—"), nunca 0. Leitura que falhou
// (`undefined`) também é `null`.

interface KpisDesconto {
  /** % dos pedidos APURADOS da amostra com desconto; null = indisponível. */
  sensibilidade: number | null;
  pedidosComDesconto: number;
  /** Pedidos da amostra cujo desconto é conhecido (denominador da sensibilidade). */
  pedidosApurados: number;
  /** Pedidos da amostra fora da conta por desconto não apurado. */
  pedidosDesconhecidos: number;
  /** Δ% da quantidade média com desconto contra sem desconto (só itens apurados); null = indisponível. */
  elasticidade: number | null;
  /** Itens da amostra fora da elasticidade por desconto não apurado. */
  itensDesconhecidos: number;
}

type EstadoDesconto = 'com' | 'sem' | 'desconhecido';

export function estadoDesconto(d: number | null | undefined): EstadoDesconto {
  if (d === null || d === undefined) return 'desconhecido';
  const n = Number(d);
  if (!Number.isFinite(n) || n < 0) return 'desconhecido';
  return n > 0 ? 'com' : 'sem';
}

function estadoPedido(itens: ReadonlyArray<{ desconto_valor: number | null }> | null | undefined): EstadoDesconto {
  if (!itens || itens.length === 0) return 'desconhecido';
  const estados = itens.map((i) => estadoDesconto(i.desconto_valor));
  if (estados.includes('com')) return 'com';
  return estados.every((e) => e === 'sem') ? 'sem' : 'desconhecido';
}

export function kpisDesconto(
  pedidos: ReadonlyArray<{ order_items: ReadonlyArray<{ desconto_valor: number | null }> | null }> | undefined,
  itens: ReadonlyArray<{ desconto_valor: number | null; quantity: number | null }> | undefined,
): KpisDesconto {
  const estadosPedido = (pedidos ?? []).map((p) => estadoPedido(p.order_items));
  const pedidosComDesconto = estadosPedido.filter((e) => e === 'com').length;
  const pedidosApurados = pedidosComDesconto + estadosPedido.filter((e) => e === 'sem').length;
  const pedidosDesconhecidos = estadosPedido.length - pedidosApurados;
  const sensibilidade = pedidosApurados > 0 ? (pedidosComDesconto / pedidosApurados) * 100 : null;

  const comQtd = (xs: ReadonlyArray<{ quantity: number | null }>) =>
    xs.filter((i) => i.quantity !== null && Number.isFinite(Number(i.quantity)));
  const com = comQtd((itens ?? []).filter((i) => estadoDesconto(i.desconto_valor) === 'com'));
  const sem = comQtd((itens ?? []).filter((i) => estadoDesconto(i.desconto_valor) === 'sem'));
  const itensDesconhecidos = (itens ?? []).filter((i) => estadoDesconto(i.desconto_valor) === 'desconhecido').length;
  let elasticidade: number | null = null;
  if (com.length > 0 && sem.length > 0) {
    const media = (xs: ReadonlyArray<{ quantity: number | null }>) =>
      xs.reduce((a, i) => a + Number(i.quantity), 0) / xs.length;
    const mediaSem = media(sem);
    if (mediaSem > 0) elasticidade = ((media(com) - mediaSem) / mediaSem) * 100;
  }
  return { sensibilidade, pedidosComDesconto, pedidosApurados, pedidosDesconhecidos, elasticidade, itensDesconhecidos };
}
