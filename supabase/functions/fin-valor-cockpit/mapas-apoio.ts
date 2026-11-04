// Mapas de apoio do cockpit (plano v5, lote 5 — VAL-IO): quatro leituras de filtros independentes
// (vínculo de cliente, nome, custo, estoque) que rodavam em SÉRIE, cada uma esperando a anterior
// paginar até o fim. Aqui elas saem juntas.
//
// O que NÃO muda (contestação do Codex no plano v5):
//  - paginação: cada uma continua no `fetchAll` (página até a curta; erro de página LANÇA);
//  - falha integral: a 1ª leitura que falhar rejeita o conjunto — nenhum mapa sai vazio no lugar
//    de um erro, e nada é calculado com 3 de 4 mapas;
//  - NÃO é snapshot transacional: são 4 requisições PostgREST, como antes (em série também não era).
import { fetchAll } from "../_shared/paginate.ts";
import type { ErroPostgrest } from "../_shared/leitura-critica.ts";

type Pagina<T> = (de: number, ate: number) => PromiseLike<{ data: T[] | null; error: ErroPostgrest | null }>;

export async function carregarMapasApoio<C, P, K, E>(leitores: {
  clientes: Pagina<C>;
  profiles: Pagina<P>;
  custos: Pagina<K>;
  estoque: Pagina<E>;
}): Promise<{ clientes: C[]; profiles: P[]; custos: K[]; estoque: E[] }> {
  const [clientes, profiles, custos, estoque] = await Promise.all([
    fetchAll(leitores.clientes, "omie_customer_account_map_fresco"),
    fetchAll(leitores.profiles, "profiles"),
    fetchAll(leitores.custos, "product_costs"),
    fetchAll(leitores.estoque, "inventory_position"),
  ]);
  return { clientes, profiles, custos, estoque };
}
