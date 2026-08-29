// Leitura de `order_items` COM O PEDIDO PAI, num único request por página, por KEYSET.
//
// Por que existe (achado da revisão independente de 2026-08-29, registrado em
// `docs/historico/paginacao-offset-janela.md` §"Segue aberto"): dois consumidores money-path
// liam `order_items` por OFFSET (`.range()`) e — no caso do cockpit — cruzavam o resultado
// com uma SEGUNDA leitura paginada de `sales_orders`. São dois defeitos distintos, e é
// importante não confundi-los, porque a correção de um não é a do outro:
//
//   1. DESLOCAMENTO. `.range()` são N requests independentes, cada um sua transação. Um hard
//      DELETE antes do offset corrente encolhe a tabela e a página seguinte começa uma linha
//      adiante: uma linha VIVA é PULADA. Os dois escritores estão vivos hoje —
//      `sync-reprocess/index.ts` (`.delete().in('id', diff.deletar)` em `order_items`, cron
//      `15 */2 * * *`, inclusive em horário comercial) e `omie-vendas-sync/index.ts` (hard
//      DELETE em `sales_orders`). A PK é uuid v4: ~50% dos INSERTs caem ANTES do cursor.
//      Medido pela revisão: 2.299 × 2.299 linhas, contagem BATENDO, uma linha viva de
//      R$ 1.000.000 omitida, sem exceção — checagem de contagem NÃO detecta.
//      Conserto: keyset (`WHERE id > cursor ORDER BY id LIMIT n`).
//
//   2. CRUZAMENTO DE INSTANTES. O cockpit lia `order_items` e `sales_orders` em DUAS
//      paginações e cruzava em memória (`pedidosNaJanela.has(l.sales_order_id)`). Migrar as
//      duas para keyset conserta cada lado e NÃO conserta o cruzamento: cada leitura fica
//      consistente consigo, nenhuma fica consistente com a outra, e o item continua podendo
//      encontrar um pai de outro instante — ou não encontrar pai nenhum, o que naquele
//      código virava DESCARTE SILENCIOSO da linha (e `?? 'outro'` no rollup por canal).
//      Conserto: o pai vem EMBEDADO (`sales_orders!inner(...)`), na mesma linha e no mesmo
//      request. É a "consulta única" que a revisão pediu — e sai mais barata que o que
//      substitui: medido em prod (psql-ro 2026-08-29), 16.548 itens no prefetch TTM + 31.114
//      pedidos = 49 páginas viravam 17.
//
// O QUE ISTO **NÃO** DÁ, e está provado como limite em `itens-com-pedido_test.ts`: keyset não
// é SNAPSHOT. Uma linha inserida atrás do cursor durante a leitura nunca é vista. É perda de
// recall RECENTE (linha nascida durante a leitura, segundos, numa janela TTM de 365 dias) —
// aceita de propósito, e diferente em natureza do dano do offset, que é linha ANTIGA e viva
// PULADA, mudando um número já fechado. Precisão > recall (`docs/agent/money-path.md` §2).
// Snapshot de verdade exigiria RPC transacional, como `omie_sync_identity_snapshot`.
//
// Mora em `_shared` e não nos dois `index.ts` pelo motivo do `recommend-leituras.ts`: as duas
// edges importam `npm:@supabase/supabase-js@2` e NUNCA rodam sob `--no-remote`, então
// enquanto a leitura morasse lá dentro nenhuma afirmação sobre ela seria EXECUTÁVEL. Aqui
// roda contra um double que satisfaz `BancoPostgrest`, no runtime real.
import { fetchAllKeyset } from "./paginate.ts";
import type { BancoPostgrest } from "./paginate.ts";
import { STATUS_NAO_VENDA_POSTGREST } from "./universo-pedidos.ts";

/**
 * O pedido pai como o cockpit precisa dele. As seis colunas são as que o cálculo usa, e cada
 * uma responde por uma decisão distinta: `status`/`deleted_at` = faturabilidade (régua
 * `pedidoContaNoFaturamento`), `order_date_kpi` = a JANELA real do TTM (a busca é por
 * `created_at`, que é data de CARGA), `account` = recorte de empresa, `origem`/`checkout_id`
 * = canal do rollup.
 */
export interface PedidoPaiCockpit {
  status: string | null;
  deleted_at: string | null;
  order_date_kpi: string | null;
  account: string | null;
  origem: string | null;
  checkout_id: string | null;
}

export interface ItemComPedidoCockpit {
  /** Chave do keyset. Não entra em nenhum cálculo — está no `.select()` porque o cursor
   *  precisa dela; sob `.range()` ela não era pedida. */
  id: string;
  customer_user_id: string;
  product_id: string | null;
  omie_codigo_produto: number | null;
  quantity: number;
  unit_price: number;
  discount: number | null;
  sales_order_id: string;
  /** `!inner` garante o pai — mas o tipo segue nullable porque é assim que o PostgREST
   *  descreve um to-one embedado, e fingir não-nulo aqui seria a mentira de tipo que o
   *  consumidor pagaria em runtime. */
  sales_orders: PedidoPaiCockpit | null;
}

const COLUNAS_COCKPIT =
  "id, customer_user_id, product_id, omie_codigo_produto, quantity, unit_price, discount, created_at, sales_order_id, " +
  "sales_orders!inner(status, deleted_at, order_date_kpi, account, origem, checkout_id)";

/**
 * Linhas de venda do cockpit: `order_items` a partir de `createdAtDe` (prefiltro de CARGA,
 * com folga — a janela REAL é por `order_date_kpi` do pai e é aplicada pelo chamador), cada
 * uma já com o pedido pai do MESMO instante.
 *
 * O `!inner` também troca um silêncio por uma ausência honesta: item sem pai visível sai da
 * lista aqui, em vez de entrar e ser descartado depois por um `.has()` que não sabe
 * distinguir "não está na janela" de "não consegui ler o pai". Hoje isso é vazio na prática —
 * `order_items.sales_order_id` tem FK para `sales_orders` e 0 órfãos/0 nulos em prod (psql-ro
 * 2026-08-29) —, então a mudança é de GARANTIA, não de resultado.
 */
export async function carregarItensCockpit(
  db: BancoPostgrest,
  createdAtDe: string,
): Promise<ItemComPedidoCockpit[]> {
  return await fetchAllKeyset<ItemComPedidoCockpit, string>(
    (cursor, limite) => {
      let q = db.from<ItemComPedidoCockpit>("order_items")
        .select(COLUNAS_COCKPIT)
        .gte("created_at", createdAtDe);
      // O cursor entra ANTES do `.order()`/`.limit()` só por leitura; no PostgREST a ordem de
      // encadeamento não muda a query. O que importa é que os três andem JUNTOS em toda
      // página: `.gt` sem `.order('id')` ascendente é keyset sobre ordem arbitrária.
      if (cursor !== null) q = q.gt("id", cursor);
      return q.order("id", { ascending: true }).limit(limite);
    },
    (l) => l.id,
    "order_items+sales_orders/cockpit",
  );
}

export interface ItemComPedidoApriori {
  id: string;
  sales_order_id: string | null;
  product_id: string | null;
  sales_orders: { status: string | null; deleted_at: string | null; account: string | null } | null;
}

const COLUNAS_APRIORI = "id, sales_order_id, product_id, sales_orders!inner(status, deleted_at, account)";

/**
 * Universo do Apriori (`omie-analytics-sync`): item com produto vinculado, de pedido que conta
 * como venda e não apagado. O resultado é PUBLICADO globalmente como regra de associação, então
 * uma linha pulada não some de uma tela — vira uma regra que ninguém consegue explicar depois.
 *
 * `id` passou a entrar no `.select()`. O comentário que ele substitui dizia o contrário e tinha
 * razão pelo que media: são ~68,7 mil linhas (medido 2026-08-29), e o uuid a mais é ~2,5 MB de
 * payload puro numa edge que já segura o universo inteiro em memória. O que aquele raciocínio
 * não pesava é o outro lado da conta — sem a coluna projetada não há cursor, e sem cursor a
 * leitura pagina por offset debaixo do hard DELETE de `sync-reprocess`. 2,5 MB é o preço de o
 * universo não ter buracos.
 */
export async function carregarItensApriori(db: BancoPostgrest): Promise<ItemComPedidoApriori[]> {
  return await fetchAllKeyset<ItemComPedidoApriori, string>(
    (cursor, limite) => {
      let q = db.from<ItemComPedidoApriori>("order_items")
        .select(COLUNAS_APRIORI)
        .not("product_id", "is", null)
        .not("sales_orders.status", "in", STATUS_NAO_VENDA_POSTGREST)
        .is("sales_orders.deleted_at", null);
      if (cursor !== null) q = q.gt("id", cursor);
      return q.order("id", { ascending: true }).limit(limite);
    },
    (l) => l.id,
    "order_items/assoc-rules",
  );
}
