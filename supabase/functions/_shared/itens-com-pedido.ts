// Leitura de `order_items` COM O PEDIDO PAI, num SNAPSHOT — uma única chamada, um único instante.
//
// Por que existe. Duas revisões independentes encontraram, em sequência, três defeitos distintos
// na mesma leitura money-path. Os dois primeiros foram fechados pela entrega de 2026-08-29/30
// (keyset + pai embedado); o terceiro é o que este módulo fecha agora. Não confundi-los importa,
// porque a correção de um não é a do outro:
//
//   1. DESLOCAMENTO. `.range()` são N requests independentes, cada um sua transação. Um hard
//      DELETE antes do offset corrente encolhe a tabela e a página seguinte começa uma linha
//      adiante: uma linha VIVA é PULADA, com a contagem BATENDO. Conserto: keyset.
//   2. CRUZAMENTO DE INSTANTES. Ler `order_items` e `sales_orders` em DUAS paginações e cruzar em
//      memória combina linhas de instantes incompatíveis. Conserto: o pai vem na MESMA linha.
//   3. CESTA RASGADA (o que este módulo fecha). O embed casa pai e filho POR LINHA e NÃO dá
//      consistência do PEDIDO ao longo das páginas: irmãos do mesmo pedido têm uuid v4 espalhado
//      e caem em páginas diferentes, então se o pai vira `cancelado` (ou é soft/hard-deletado) no
//      meio da leitura, os irmãos já lidos FICAM e os posteriores são eliminados pelo filtro do
//      embed. Sai MEIO PEDIDO, sem exceção, com todos os ids crescentes — e os guards de
//      `fetchAllKeyset` não veem, porque só olham as chaves DEVOLVIDAS e o que o filtro suprimiu
//      é invisível para eles. Medido em prod (2026-08-30): 16.713 dos 31.114 pedidos têm mais de
//      um item — MAIS DA METADE do universo é exposta. Não existe instante em que essa cesta
//      parcial seja verdadeira: é perda de PRECISÃO (§1), não o "recall recente" já aceito.
//
// O CONSERTO. A paginação DESAPARECE destes dois consumidores: cada leitura passa a ser uma
// chamada a uma RPC que devolve o universo inteiro, construído por UMA ÚNICA query SQL — e uma
// statement enxerga UM snapshot MVCC. Pai e filhos, e todos os pedidos entre si, vêm do mesmo
// instante por CONSTRUÇÃO, não por detecção. Isso fecha, junto, o recall recente (não há mais
// cursor para uma linha nascer atrás) e a falta de orçamento de páginas do `fetchAllKeyset`.
// A migration é `20260830123820_snapshot_atomico_universo_itens.sql`; o porquê de a garantia NÃO
// depender do qualificador `STABLE` está no cabeçalho dela, e a prova executável (com concorrência
// real e falsificação) em `db/test-snapshot-universo-itens.sh`.
//
// ⚠️ O QUE ISTO **NÃO** DÁ, e que segue ABERTO. A garantia é de LEITURA: tudo que volta pertence a
// um instante do banco. Isso não é o mesmo que uma revisão logicamente completa do PEDIDO, porque
// o writer não é atômico — `sync-reprocess` reparte a reconciliação de um pedido em VÁRIAS
// transações (itens numa, remoção dos velhos noutra, cabeçalho depois). Existe portanto um
// instante REAL e commitado em que o pedido está meio-reconciliado, e este snapshot vai lê-lo
// corretamente, porque ele existiu. A diferença com a cesta rasgada é essencial: aquela era um
// estado que NUNCA existiu (artefato da paginação); esta EXISTIU. Fechá-la exige atomizar a
// ESCRITA, e está registrado como pendência ABERTA em `docs/historico/paginacao-offset-janela.md`.
// (Achado do challenge Codex gpt-5.6-sol/xhigh sobre esta entrega.)
//
// Mora em `_shared` e não nos dois `index.ts` pelo motivo do `recommend-leituras.ts`: as duas
// edges importam `npm:@supabase/supabase-js@2` e NUNCA rodam sob `--no-remote`, então enquanto a
// leitura morasse lá dentro nenhuma afirmação sobre ela seria EXECUTÁVEL. Aqui roda contra um
// double que satisfaz `BancoPostgrest`, no runtime real.
import { FalhaLeituraCritica } from "./leitura-critica.ts";
import type { BancoPostgrest } from "./paginate.ts";
import { STATUS_NAO_VENDA } from "./universo-pedidos.ts";

/**
 * Valida o ENVELOPE da RPC e devolve os itens. FAIL-CLOSED em toda forma inesperada — mesmo
 * padrão de `parseIdentitySnapshot` (a outra RPC-snapshot deste repo).
 *
 * Por que um envelope com `total` em vez de devolver o array pelado: `total` é calculado no BANCO
 * e comparado aqui com o comprimento REAL do array. Divergiu, alguma camada entre o Postgres e o
 * Deno entregou menos do que o banco produziu — e a resposta certa a isso é LANÇAR, nunca seguir
 * com o que chegou. É a mesma defesa que `fetchAll` monta contra o cap silencioso de 1.000 linhas
 * do PostgREST, no lugar onde a paginação deixou de existir.
 */
function itensDoSnapshot(bruto: unknown, label: string): unknown[] {
  // `null`/escalar/array são todos MALFORMADOS: a RPC devolve um OBJETO. Note que um array aqui
  // não é "quase certo" — seria a resposta de uma função SETOF, isto é, outra função.
  // Código `MALFORMADA`, o MESMO que `fetchAll`/`exigirLista` dão à malformada de uma página: é o
  // mesmo defeito entrando pela porta do lado, e quem lê o log não deveria ter de saber por qual.
  if (bruto === null || typeof bruto !== "object" || Array.isArray(bruto)) {
    throw new FalhaLeituraCritica(label, { code: "MALFORMADA" });
  }
  const envelope = bruto as Record<string, unknown>;
  if (!Array.isArray(envelope.itens)) {
    throw new FalhaLeituraCritica(label, { code: "MALFORMADA" });
  }
  const total = envelope.total;
  if (typeof total !== "number" || !Number.isFinite(total)) {
    throw new FalhaLeituraCritica(label, { code: "MALFORMADA" });
  }
  if (total !== envelope.itens.length) {
    // Domínio FECHADO na mensagem (os dois números são contagens, não conteúdo de linha) — o
    // `catch` do `Deno.serve` devolve `.message` no CORPO da resposta HTTP.
    throw new FalhaLeituraCritica(label, {
      code: "SNAPSHOT_TRUNCADO",
      message: `o banco produziu ${total} itens e chegaram ${envelope.itens.length} — houve truncagem no transporte`,
    });
  }
  return envelope.itens;
}

/** Executa a RPC-snapshot e devolve os itens já validados. */
async function lerSnapshot(
  db: BancoPostgrest,
  fn: string,
  args: Record<string, unknown>,
): Promise<unknown[]> {
  // `rpc<unknown>` porque o tipo da interface (`data: T[] | null`) descreve o caso SETOF, e estas
  // funções devolvem UM `jsonb` escalar. Não há cast fingindo o contrário: o que chega é `unknown`
  // e quem estabelece a forma é `itensDoSnapshot`, em RUNTIME. Tipo estático não sabe o que o
  // PostgREST devolveu; o parser sabe.
  const { data, error } = await db.rpc<unknown>(fn, args);
  // Envelope na ORIGEM: o `code` do PostgREST (57014 timeout, 42501 RLS, 54000 teto estourado) é o
  // que separa "o banco piscou" de "a role não enxerga" de "o universo cresceu além do fusível" na
  // classificação operacional — e morreria num envelope aplicado por fora.
  if (error) throw new FalhaLeituraCritica(fn, error);
  return itensDoSnapshot(data, fn);
}

export interface ItemComPedidoApriori {
  sales_order_id: string | null;
  product_id: string | null;
  /** O pai continua aninhado (e não achatado) para o consumidor não mudar: ele lê
   *  `item.sales_orders?.account`. Só `account` sobrevive porque status e `deleted_at` eram
   *  insumo do FILTRO, e o filtro agora é aplicado dentro da RPC. */
  sales_orders: { account: string | null } | null;
}

/**
 * Universo do Apriori (`omie-analytics-sync`): item com produto vinculado, de pedido que conta
 * como venda e não apagado. O resultado é PUBLICADO globalmente como regra de associação, então
 * uma cesta partida não some de uma tela — vira uma regra que ninguém consegue explicar depois.
 *
 * A denylist vai como PARÂMETRO, e não embutida na RPC, para a autoridade seguir sendo
 * `STATUS_NAO_VENDA` deste repo. Mas a função do banco carrega a lista canônica e REJEITA uma
 * divergente (não só vazia ou com NULL: uma lista que OMITA `cancelado` também) — o espelho TS↔SQL,
 * que hoje é um guard de teste, passa a ser invariante EXECUTÁVEL em produção. Divergiu, a leitura
 * para; que é o desfecho certo quando a alternativa é publicar regra sobre o que não é venda.
 */
export async function carregarItensApriori(db: BancoPostgrest): Promise<ItemComPedidoApriori[]> {
  const itens = await lerSnapshot(db, "apriori_universo_snapshot", {
    p_status_nao_venda: STATUS_NAO_VENDA,
  });
  return itens as ItemComPedidoApriori[];
}

/**
 * O pedido pai como o cockpit precisa dele. As seis colunas são as que o cálculo usa, e cada uma
 * responde por uma decisão distinta: `status`/`deleted_at` = faturabilidade (régua
 * `pedidoContaNoFaturamento`), `order_date_kpi` = a JANELA real do TTM (a busca é por `created_at`,
 * que é data de CARGA), `account` = recorte de empresa, `origem`/`checkout_id` = canal do rollup.
 */
// NÃO exportada de propósito: ninguém fora daqui a nomeia, e `export` sem consumidor reprova no
// gate de dead code (`bunx knip`, passo do CI que roda DEPOIS do typecheck e dos testes — então uma
// suíte inteiramente verde não diz nada sobre ele; foi assim que este arquivo reprovou). Ela segue
// visível onde importa: `ItemComPedidoCockpit`, que é exportado, a referencia.
interface PedidoPaiCockpit {
  status: string | null;
  deleted_at: string | null;
  order_date_kpi: string | null;
  account: string | null;
  origem: string | null;
  checkout_id: string | null;
}

export interface ItemComPedidoCockpit {
  customer_user_id: string;
  product_id: string | null;
  omie_codigo_produto: number | null;
  quantity: number;
  unit_price: number;
  discount: number | null;
  sales_order_id: string;
  /** O JOIN interno da RPC garante o pai — mas o tipo segue nullable porque fingir não-nulo aqui
   *  seria a mentira de tipo que o consumidor pagaria em runtime, e o consumidor CONTA os casos em
   *  que ele falta em vez de assumir que não acontecem. */
  sales_orders: PedidoPaiCockpit | null;
}

/**
 * Linhas de venda do cockpit: `order_items` a partir de `createdAtDe` (prefiltro de CARGA, com
 * folga — a janela REAL é por `order_date_kpi` do pai e é aplicada pelo chamador), cada uma já com
 * o pedido pai do MESMO instante.
 *
 * A RPC não aplica régua de faturabilidade nem janela: as duas continuam no consumidor, sobre o pai
 * que vem junto. É contrato mantido de propósito — esta entrega é de TRANSPORTE, e mover regra de
 * negócio para o banco no mesmo passo tornaria impossível dizer qual das duas mudanças moveu um
 * número.
 */
export async function carregarItensCockpit(
  db: BancoPostgrest,
  createdAtDe: string,
): Promise<ItemComPedidoCockpit[]> {
  const itens = await lerSnapshot(db, "cockpit_itens_snapshot", {
    p_created_at_de: createdAtDe,
  });
  return itens as ItemComPedidoCockpit[];
}
