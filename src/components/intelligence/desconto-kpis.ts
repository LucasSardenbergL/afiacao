// KPIs de desconto da aba estratégica — com degradação HONESTA.
//
// `sales_orders.discount` e `order_items.discount` são 0 em 100% das linhas (DEFAULT 0, nenhum
// escritor: medido 2026-10-01 — 31.678 pedidos e 71.909 itens). Ali zero não é "não houve
// desconto", é "o desconto não é registrado nesta coluna" — e a conta em cima dele fabricava
// "Sensibilidade a Desconto 0%" e "Elasticidade de Preço −100%" (nenhum item "com desconto" ⇒ média
// 0 contra a média dos demais). Sem NENHUMA linha com desconto > 0, o KPI é `null`: precisão >
// recall — um 0% verdadeiro também cai aqui, e é o certo, porque daqui ele não se distingue de dado
// ausente. Leitura que falhou (`undefined`) também é `null`, nunca 0.

interface KpisDesconto {
  /** % dos pedidos da amostra com desconto; null = indisponível. */
  sensibilidade: number | null;
  pedidosComDesconto: number;
  pedidos: number;
  /** Δ% da quantidade média com desconto contra sem desconto; null = indisponível. */
  elasticidade: number | null;
}

const temDesconto = (d: number | null | undefined) => Number(d ?? 0) > 0;

export function kpisDesconto(
  pedidos: ReadonlyArray<{ discount: number | null }> | undefined,
  itens: ReadonlyArray<{ discount: number | null; quantity: number | null }> | undefined,
): KpisDesconto {
  const nPedidos = pedidos?.length ?? 0;
  const pedidosComDesconto = pedidos?.filter((p) => temDesconto(p.discount)).length ?? 0;
  const sensibilidade = pedidosComDesconto > 0 ? (pedidosComDesconto / nPedidos) * 100 : null;

  let elasticidade: number | null = null;
  const com = itens?.filter((i) => temDesconto(i.discount)) ?? [];
  const sem = itens?.filter((i) => !temDesconto(i.discount)) ?? [];
  if (com.length > 0 && sem.length > 0) {
    const media = (xs: ReadonlyArray<{ quantity: number | null }>) =>
      xs.reduce((a, i) => a + Number(i.quantity), 0) / xs.length;
    const mediaSem = media(sem);
    if (mediaSem > 0) elasticidade = ((media(com) - mediaSem) / mediaSem) * 100;
  }
  return { sensibilidade, pedidosComDesconto, pedidos: nPedidos, elasticidade };
}
