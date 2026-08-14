// O universo da TELA do farmer — recorte de exibição alinhado ao escopo da RPC de margem.
//
// Extraído para cá (e não deixado inline no `useFarmerScoring`) pelo mesmo motivo de
// `healthScore.ts`: a regra que importa é o comportamento de BORDA, e ele não era testável no
// meio de query + agregação.
//
// POR QUE EXISTE (medido em prod 2026-08-13 — `docs/historico/farmer-scoring-paridade-ts-sql.md`):
// o hook lista `sales_orders` company-wide (835 clientes), mas `get_carteira_margem_faixa()`
// responde só pela carteira do caller. Para as duas vendedoras reais, 541 e 440 dos 835 clientes
// da tela eram de OUTRA carteira — e apareciam com "Sem custo conhecido" em 562/464 casos.
// Alinhar a tela ao escopo da RPC derruba isso para 21/24 e devolve o sinal de margem a ~94% da
// carteira, ao custo de 11–12 dos 20 slots da agenda (decisão do founder, 2026-08-14).

export interface EscopoCarteira {
  /** `cap_carteira_ler` = master OU employee gerencial/estrategico/super_admin. */
  capCarteiraLer: boolean;
  /** Clientes visíveis. Vem da RLS de `carteira_assignments`, que JÁ é `carteira_visivel_para`. */
  carteira: Set<string>;
}

/**
 * Recorta a lista de clientes ao que o caller pode ver.
 *
 * ⚠️ FAIL-CLOSED: carteira vazia sem `cap_carteira_ler` devolve LISTA VAZIA, nunca a base
 * inteira. É o acidente do money-path.md §7 ao contrário — lá o caller leu lista vazia como
 * "este farmer não tem carteira, deve ser super_admin" e recarregou SEM filtro, transformando a
 * base inteira no universo do cálculo. Vendedora sem carteira vê zero clientes, não vê todos.
 *
 * ⚠️ A carteira RECORTA, não expande: assignment de cliente sem pedido não faz aparecer alguém
 * que o motor não pontuou. E a ORDEM de entrada é preservada, porque ela carrega a prioridade já
 * calculada — reordenar aqui mudaria a agenda por efeito colateral de um filtro.
 */
export function filtrarPorCarteira(clientes: string[], escopo: EscopoCarteira): string[] {
  if (escopo.capCarteiraLer) return clientes;
  return clientes.filter((cid) => escopo.carteira.has(cid));
}
