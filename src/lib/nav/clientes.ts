// Navegação da tela Clientes: a ficha sabe de qual fila veio, e voltar devolve a MESMA fila.
//
// Por quê: abrir um cliente da lista e voltar jogava a vendedora em /admin/customers "cru" — sem a
// busca, o filtro de saúde, a ordem e a posição em que ela estava (onda 1, item 6). Os filtros moram
// na URL (`useUrlState`), então a origem é a query string da lista + a rolagem da janela.
// Funções PURAS: o teste trava quais parâmetros viajam e como a origem é lida do `location.state`.
//
// Onda 2 (item 8): a 360 é o destino ÚNICO de "abrir cliente" (lista, agenda, telefonia, carteira…);
// a ficha antiga em /admin/customers/:id virou "Cadastro e ferramentas", aberta pela 360. Por isso este
// helper saiu de `adminCustomers/` para `lib/nav/` (plataforma): a 360 (farmer-inteligencia) e a lista
// (admin-crm) o usam sem uma aresta de fronteira entre os dois módulos.

/** Parâmetros da lista que definem a FILA (o resto da URL não viaja). */
const PARAMS_DA_FILA = ['search', 'health', 'ordem'] as const;

/** Origem guardada no `location.state` da ficha: a query da fila e a rolagem em que estava. */
export interface OrigemLista {
  /** Query string da fila, já com `?` (ou '' para a lista sem filtro). */
  query: string;
  /** `window.scrollY` no momento do clique; `null` = não medida. */
  rolagem: number | null;
}

/**
 * Query string só com os parâmetros da fila, na ordem fixa e sem valor vazio.
 * Aceita a `location.search` (com ou sem `?`) ou um `URLSearchParams`.
 */
export function queryDaFila(origem: string | URLSearchParams): string {
  const params = typeof origem === 'string' ? new URLSearchParams(origem) : origem;
  const saida = new URLSearchParams();
  for (const chave of PARAMS_DA_FILA) {
    const v = params.get(chave);
    if (v != null && v !== '') saida.set(chave, v);
  }
  const s = saida.toString();
  return s ? `?${s}` : '';
}

/** Lista de clientes com a fila de origem. */
export function urlListaClientes(query: string = ''): string {
  return `/admin/customers${queryDaFila(query)}`;
}

/**
 * "Cadastro e ferramentas" do cliente (a ficha antiga), carregando a fila na URL — a lista por trás
 * segue a mesma key. NÃO é destino de "abrir cliente": quem abre cliente usa `urlCliente360`.
 */
export function urlCadastroCliente(customerId: string, query: string = ''): string {
  return `/admin/customers/${encodeURIComponent(customerId)}${queryDaFila(query)}`;
}

/** `location.state` que leva a fila de origem adiante (ou nada, quando a tela não veio da lista). */
export function estadoComOrigem(origem: OrigemLista | null | undefined): { origemLista: OrigemLista } | undefined {
  return origem ? { origemLista: origem } : undefined;
}

/** Visão 360 do cliente — o destino único de "abrir cliente". */
export function urlCliente360(customerId: string): string {
  return `/admin/customers/${encodeURIComponent(customerId)}/360`;
}

/** Novo pedido já com o cliente — o `UnifiedOrder` lê `?customer=`. */
export function urlNovoPedido(customerId: string): string {
  return `/sales/new?customer=${encodeURIComponent(customerId)}`;
}

/** Pedidos de venda filtrados pelo cliente — o `useSalesOrders` lê `?customer=`. */
export function urlPedidosDoCliente(customerId: string): string {
  return `/sales?customer=${encodeURIComponent(customerId)}`;
}

/** Rolagem válida (inteiro ≥ 0, finito) ou `null`. */
function rolagemValida(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** Monta a origem a partir da URL atual da lista e da rolagem medida. */
export function montarOrigemLista(search: string, rolagem: number | null | undefined): OrigemLista {
  return { query: queryDaFila(search), rolagem: rolagemValida(rolagem) };
}

/**
 * Lê a origem do `location.state` (que é `unknown`: pode vir de outra tela, de um link externo ou de
 * uma versão antiga do app). Formato inesperado → `null`, e quem chama cai na lista sem filtro.
 */
export function lerOrigemLista(state: unknown): OrigemLista | null {
  if (state == null || typeof state !== 'object') return null;
  const origem = (state as { origemLista?: unknown }).origemLista;
  if (origem == null || typeof origem !== 'object') return null;
  const { query, rolagem } = origem as { query?: unknown; rolagem?: unknown };
  if (typeof query !== 'string') return null;
  return { query: queryDaFila(query), rolagem: rolagemValida(rolagem) };
}

/** Rolagem a restaurar ao voltar para a lista (`location.state.rolagem`), ou `null`. */
export function lerRolagemARestaurar(state: unknown): number | null {
  if (state == null || typeof state !== 'object') return null;
  return rolagemValida((state as { rolagem?: unknown }).rolagem);
}
