/**
 * QUAL preço pago vira a referência do up-sell — o denominador de `razaoPreco`.
 *
 * O motor reduz `sales_orders` a um histórico `(cliente, SKU) → preço` com a regra "último item
 * vence". "Último" era a ordem de LEITURA: `fetchAllPages` pagina com `.order('id')`, e `id` é
 * uuid. Ordem de uuid não tem relação nenhuma com a data do pedido — então o preço de referência
 * era o de uma ocorrência ARBITRÁRIA entre as compras daquele SKU por aquele cliente.
 *
 * Isso sempre governou a ELEGIBILIDADE (`premiumPrice > referencia * PISO_RAZAO_UP_SELL`). Desde
 * o #1837 governa também a ORDEM: `razaoPreco = premiumPrice / referencia` é a chave PRIMÁRIA do
 * `compararCandidatosUpSell`. Referência arbitrária ⇒ razão arbitrária ⇒ top-2 arbitrário.
 *
 * MEDIDO em prod (psql-ro, 07/09/2026 — réplica do motor em SQL, com controle: o mesmo ranking
 * comparado a SI MESMO dá zero divergência):
 *   · 13.287 pares `(cliente, SKU)` com preço utilizável;
 *   · em **2.349 (17,7%)** a ordem de uuid escolhe preço DIFERENTE do pedido mais recente;
 *   · magnitude |Δ|: mediana **13,7%**, p90 **42,2%**; 1.545 pares ≥10% e 177 ≥50%;
 *   · em **3.881 (29,2%)** o uuid pegou um pedido ESTRITAMENTE mais antigo — mediana **238
 *     dias**, p90 830, máximo **2.250 dias** (~6 anos);
 *   · e o que decidiu agir: dos 1.060 clientes com up-sell, **166 (15,7%)** recebem um top-2
 *     DIFERENTE. Nenhum cliente ganha ou perde up-sell — a troca é de QUEM é ofertado.
 *
 * A ESCOLHA: o preço do pedido **mais recente por `created_at`**. É o mesmo TIPO de grandeza que
 * o código já usava — um preço que este cliente de fato pagou —, então o significado de "salto"
 * não muda; o que muda é o eixo da seleção passar a ser o que o código sempre afirmou ser.
 *
 * Descartadas, e por quê:
 *   · **mediana das últimas N** inventa o parâmetro `N` sem dado para calibrá-lo, e mistura
 *     patamares de preço de épocas distintas (aqui há pares com 6 anos entre as pontas);
 *   · **preço de tabela do SKU** joga fora o preço NEGOCIADO e torna `razaoPreco` idêntica para
 *     todos os clientes — apagaria a personalização que é o motivo de o up-sell ser por cliente.
 *
 * ⚠️ A ordem de PAGINAÇÃO continua `.order('id')` e não pode mudar: `id` é PK e dá a ordem TOTAL
 * estável que a paginação do PostgREST exige (capa de 1.000 silenciosa, inclusive em `.rpc()`).
 * A recência é decidida na REDUÇÃO em memória, não na leitura.
 */

/**
 * `sales_orders.created_at` como instante comparável, ou `null` quando ilegível.
 *
 * `Date.parse` devolve `NaN` para lixo, e `NaN` em comparação é sempre `false` — um pedido com
 * data podre venceria ou perderia conforme o lado da comparação. `null` explícito força o
 * tratamento declarado em `compararRecencia`: sem data não se AFIRMA recência.
 *
 * Medido em prod: 0 dos 31.224 pedidos do universo têm `created_at` nulo. O ramo existe para o
 * dia em que um tiver — não para o dado de hoje.
 */
export function instanteDoPedido(raw: unknown): number | null {
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw.getTime() * 1000 : null;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  // Em MICROSSEGUNDOS, não em ms: `timestamptz` do Postgres guarda microssegundo e
  // `Date.parse` TRUNCA a fração em 3 dígitos (medido: `.123999Z` e `.123001Z` viram os
  // MESMOS 123ms). Truncar funde dois pedidos no mesmo instante e joga a decisão no desempate
  // por `id` — justo o eixo que este módulo existe para tirar da jogada. MEDIDO em prod
  // (07/09/2026): 26 dos 31.224 pedidos têm fração de segundo (resíduo de quando o sync usava
  // `now()`; hoje ele grava MEIO-DIA UTC da data canônica) e **nenhum par colide** — 0 de
  // 13.287. O ramo defende contra o dado que já existiu, não contra o de hoje.
  // A conta cabe em double até ~2255 (1,8e15 < 9,0e15 de `MAX_SAFE_INTEGER`).
  const fracao = /\d{2}:\d{2}:\d{2}\.(\d+)/.exec(raw)?.[1] ?? '';
  return ms * 1000 + Number(`${fracao}000000`.slice(3, 6));
}

/**
 * De ONDE veio o preço que está valendo — o suficiente para decidir recência sem ambiguidade.
 */
export interface MarcaDeCompra {
  /** `created_at` do pedido em epoch MICROSSEGUNDOS; `null` se ilegível (ver `instanteDoPedido`). */
  instante: number | null;
  /**
   * `sales_orders.id`. Desempata `created_at` igual — 258 pares (1,94%) em prod.
   *
   * ⚠️ Comparado como STRING, e isso só reproduz a regra antiga ("vence quem a leitura viu por
   * último", i.e. o maior `id` de `.order('id')`) porque o texto do uuid é canônico minúsculo:
   * os hífens caem nas mesmas posições nos dois lados e, em ASCII, `'0'..'9' < 'a'..'f'`, então
   * a ordem lexicográfica coincide com a ordem binária que o Postgres usa em `uuid`. MEDIDO em
   * prod (07/09/2026), não deduzido: 31.248 pedidos, 0 fora do canônico minúsculo, e ordenar
   * por `id` e por `id::text COLLATE "C"` devolve a MESMA sequência (0 divergências).
   */
  pedidoId: string;
  /**
   * Índice do PEDIDO na leitura paginada. Só desempata quando `pedidoId` não distingue — hoje
   * impossível (PK), e é justamente por isso que ele existe: se um dia o `id` sumir do
   * `select`, `pedidoId` colapsa para `''` em TODOS os pedidos e a `posicao` passaria a
   * comparar itens de pedidos DIFERENTES, inventando uma ordem entre coisas incomparáveis.
   * Com este campo, o pior caso degrada para a ordem de LEITURA — a regra antiga, que é ruim
   * mas é coerente. Achado do challenge Codex.
   */
  ordemDeLeitura: number;
  /** Índice do item no array `items` do pedido. Desempata DENTRO do mesmo pedido. */
  posicao: number;
}

/**
 * `> 0` quando `a` é mais recente que `b`. Ordem lexicográfica: instante, depois pedido, depois
 * posição no pedido.
 *
 * FAIL-CLOSED no instante ausente: uma marca sem data NUNCA supera uma com data. Sem `created_at`
 * não há como afirmar que aquele preço é o mais recente, e `precisão > recall` manda não
 * sobrescrever na dúvida.
 *
 * ⚠️ Quando NENHUM dos dois lados tem data, o desempate cai em `pedidoId` — que é exatamente a
 * regra de hoje (a leitura vem ordenada por `id`). Isso é DEGRADAÇÃO HONESTA, não descuido:
 * mantém um preço realmente observado em vez de descartar o SKU, que é o mesmo erro que o #2224
 * consertou (ausência de dado apagando oferta legítima).
 */
export function compararRecencia(a: MarcaDeCompra, b: MarcaDeCompra): number {
  if (a.instante !== b.instante) {
    if (a.instante === null) return -1;
    if (b.instante === null) return 1;
    return a.instante - b.instante;
  }
  if (a.pedidoId !== b.pedidoId) return a.pedidoId < b.pedidoId ? -1 : 1;
  if (a.ordemDeLeitura !== b.ordemDeLeitura) return a.ordemDeLeitura - b.ordemDeLeitura;
  return a.posicao - b.posicao;
}
