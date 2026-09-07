// Testa o CÓDIGO REAL de `itens-com-pedido.ts` (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/itens-com-pedido_test.ts
//
// Sem import remoto (jsr:/npm:) — `test:edges` roda com `--no-remote` e BLOQUEIA o CI. O "banco" é
// um double que satisfaz `BancoPostgrest`, o contrato estrutural dos loaders (padrão de
// `recommend-leituras_test.ts` / `mapas-paginados_test.ts`).
//
// O QUE ESTE ARQUIVO PROVA. `fin-valor-cockpit/index.ts` e `omie-analytics-sync/index.ts` importam
// `npm:@supabase/supabase-js@2`, então NUNCA rodam sob `--no-remote`: enquanto a leitura morasse lá
// dentro, "a cesta não sai partida" seria uma afirmação sem execução.
//
// ⚠️ ESTE ARQUIVO MUDOU DE AFIRMAÇÃO, DE PROPÓSITO. A versão anterior tinha um caso chamado
// "LIMITE CONHECIDO: a CESTA RASGA entre páginas quando o pai muda de estado", que afirmava o
// comportamento REAL (1 de 2 irmãos) para o limite não passar por consertado. O limite FOI
// consertado: a leitura deixou de paginar e passa por uma RPC-snapshot construída por uma única
// query SQL. Aquele caso está reescrito logo abaixo — "a cesta NÃO rasga" — e não apagado, porque
// quem vier depois precisa achar o cenário e ver que ele agora exige o desfecho oposto.
//
// A prova de que o BANCO cumpre a sua metade (uma statement = um snapshot MVCC, com escrita
// concorrente real e falsificação) é `db/test-snapshot-universo-itens.sh`, em PG17. Aqui prova-se a
// metade do CLIENTE: uma única ida ao banco, o parâmetro certo, e fail-closed em toda resposta que
// não seja o envelope combinado.
import { carregarItensApriori, carregarItensCockpit } from "./itens-com-pedido.ts";
import { FalhaLeituraCritica } from "./leitura-critica.ts";
import type { BancoPostgrest, QueryPostgrest } from "./paginate.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
async function assertLanca(fn: () => Promise<unknown>, msg: string): Promise<FalhaLeituraCritica> {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof FalhaLeituraCritica, `${msg}: lançou ${e}, que não é FalhaLeituraCritica`);
    return e as FalhaLeituraCritica;
  }
  throw new Error(`${msg}: NÃO lançou — a falha foi engolida`);
}

type Chamada = { fn: string; args: Record<string, unknown> };
type Resposta = { data: unknown; error: { message: string; code?: string | null } | null };

/**
 * Double do banco pela porta da RPC. Registra CADA chamada — é o que torna "uma única ida ao
 * banco" uma asserção de verdade em vez de uma intenção escrita no comentário.
 *
 * `aoResponder` recebe o número da chamada (1-based) e devolve a resposta. É o gancho por onde um
 * writer concorrente "atuaria entre as páginas": se houvesse uma segunda ida, ele a veria.
 */
function fakeDb(aoResponder: (n: number, c: Chamada) => Resposta): {
  db: BancoPostgrest;
  chamadas: Chamada[];
} {
  const chamadas: Chamada[] = [];
  const db: BancoPostgrest = {
    from<T>(): QueryPostgrest<T> {
      throw new Error("o loader NÃO pode usar .from() — a leitura é a RPC-snapshot, sem paginação");
    },
    rpc<T>(fn: string, args: Record<string, unknown>) {
      chamadas.push({ fn, args });
      const r = aoResponder(chamadas.length, { fn, args });
      return Promise.resolve(r as { data: T[] | null; error: Resposta["error"] });
    },
  };
  return { db, chamadas };
}

const envelope = (itens: unknown[]) => ({
  data: { total: itens.length, bytes_itens: 1, itens },
  error: null,
});

const itemApriori = (pedido: string, produto: string, account = "oben") => ({
  sales_order_id: pedido,
  product_id: produto,
  sales_orders: { account },
});

// ── O caso que herdou o nome do limite fechado ────────────────────────────────────────────────
Deno.test("a CESTA NÃO RASGA: irmãos do mesmo pedido vêm do MESMO instante", async () => {
  // O cenário é o mesmo da versão anterior deste arquivo, e é justamente por isso que ele fica
  // aqui: dois irmãos do MESMO pedido, e um writer que cancela o pai "no meio da leitura".
  //
  // Antes, a leitura eram 69 páginas e o writer tinha 68 frestas para atuar: o irmão da 1ª página
  // ficava no acumulado e o da 2ª era eliminado pelo filtro do embed — 1 de 2, sem exceção
  // nenhuma. Agora a leitura é UMA chamada, e o "meio" não existe: o double abaixo está armado
  // para servir uma cesta partida em qualquer chamada a partir da SEGUNDA, e essa chamada nunca
  // acontece. Não é que o defeito ficou raro; é que a fresta em que ele morava deixou de existir.
  const PEDIDO = "so-COMPARTILHADO";
  const cestaInteira = [itemApriori(PEDIDO, "p-A"), itemApriori(PEDIDO, "p-B")];
  const { db, chamadas } = fakeDb((n) =>
    n === 1 ? envelope(cestaInteira) : envelope([itemApriori(PEDIDO, "p-A")])
  );

  const linhas = await carregarItensApriori(db);
  const doPedido = linhas.filter((l) => l.sales_order_id === PEDIDO);

  assertEquals(
    doPedido.length,
    2,
    `esperava a cesta INTEIRA (2 de 2 irmãos). Veio ${doPedido.length} — se veio 1, a leitura ` +
      `voltou a ser multi-ida e o defeito que esta entrega fechou está de volta`,
  );
  assertEquals(
    chamadas.length,
    1,
    "houve mais de uma ida ao banco — é exatamente entre elas que a cesta rasgava",
  );
});

Deno.test("apriori: uma única chamada, à RPC certa, com a denylist CANÔNICA", async () => {
  const { db, chamadas } = fakeDb(() => envelope([itemApriori("so-1", "p-1")]));
  await carregarItensApriori(db);

  assertEquals(chamadas.length, 1, "a leitura não pode ir ao banco mais de uma vez");
  assertEquals(chamadas[0].fn, "apriori_universo_snapshot", "chamou outra função");
  // A denylist é o insumo do universo: uma lista que OMITA `cancelado` publica regra de associação
  // sobre pedido que não é venda. O banco também rejeita divergência — este assert prova o lado de
  // cá, que é quem escolhe o que mandar.
  assertEquals(
    chamadas[0].args.p_status_nao_venda,
    ["cancelado", "rascunho", "pendente", "orcamento"],
    "a denylist enviada não é a canônica de `universo-pedidos.ts`",
  );
});

Deno.test("cockpit: uma única chamada, com o prefiltro de carga repassado", async () => {
  const { db, chamadas } = fakeDb(() => envelope([]));
  await carregarItensCockpit(db, "2025-08-30T00:00:00.000Z");

  assertEquals(chamadas.length, 1, "a leitura não pode ir ao banco mais de uma vez");
  assertEquals(chamadas[0].fn, "cockpit_itens_snapshot", "chamou outra função");
  assertEquals(
    chamadas[0].args.p_created_at_de,
    "2025-08-30T00:00:00.000Z",
    "o prefiltro de carga não chegou à RPC — sem ele a leitura viraria a tabela inteira",
  );
});

Deno.test("o loader NÃO pode voltar a paginar por .from()", async () => {
  // Guard de REGRESSÃO com dente próprio: o `from()` do double lança. Se alguém reintroduzir uma
  // leitura paginada aqui — por "otimização", por merge malfeito —, este teste morde antes de a
  // cesta voltar a rasgar em produção.
  const { db } = fakeDb(() => envelope([]));
  let usouFrom = false;
  try {
    db.from("order_items");
  } catch {
    usouFrom = true;
  }
  assert(usouFrom, "o double deixou de barrar `.from()` — o guard de regressão perdeu o dente");
});

// ── Fail-closed do envelope ───────────────────────────────────────────────────────────────────
Deno.test("envelope: `total` que não bate com o array é TRUNCAGEM, e LANÇA", async () => {
  // O cenário real: o banco produziu N itens e chegaram menos. Sem este guard a leitura seguiria
  // com o pedaço — que é a truncagem silenciosa do cap de 1.000 do PostgREST, no lugar onde a
  // paginação (e as suas defesas) deixaram de existir.
  const { db } = fakeDb(() => ({
    data: { total: 9, bytes_itens: 1, itens: [itemApriori("so-1", "p-1")] },
    error: null,
  }));
  const e = await assertLanca(() => carregarItensApriori(db), "total divergente");
  assertEquals(e.codigo, "SNAPSHOT_TRUNCADO", "o código não distingue truncagem de malformada");
});

Deno.test("envelope: formas malformadas LANÇAM, nunca viram lista vazia", async () => {
  // `null` é o caso que mais dói: `?? []` o transformaria em "não há itens", e o consumidor
  // publicaria um universo VAZIO como se fosse a verdade medida. Ausente ≠ zero (§2).
  const formas: Array<[string, unknown]> = [
    ["null", null],
    ["escalar", 42],
    ["array pelado (resposta de função SETOF, não desta)", [{ sales_order_id: "so-1" }]],
    ["objeto sem `itens`", { total: 0 }],
    ["`itens` que não é array", { total: 0, itens: "CPF" }],
    ["objeto sem `total`", { itens: [] }],
    ["`total` não-finito", { total: Number.NaN, itens: [] }],
  ];
  for (const [nome, data] of formas) {
    const { db } = fakeDb(() => ({ data, error: null }));
    const e = await assertLanca(() => carregarItensApriori(db), `forma ${nome}`);
    assertEquals(e.codigo, "MALFORMADA", `forma ${nome}: código errado`);
  }
});

Deno.test("erro do PostgREST LANÇA preservando o código (o teto tem código próprio)", async () => {
  // `54000` é o fusível de teto da RPC. Ele precisa chegar ao operador COMO 54000: "o universo
  // cresceu além do fusível" tem conserto diferente de "a role não enxerga" (42501) e de "o banco
  // piscou" (57014). Reduzir os três a "falhou" manda quem lê o log caçar a coisa errada.
  const { db } = fakeDb(() => ({
    data: null,
    error: { message: "universo com 40000000 bytes excede o teto", code: "54000" },
  }));
  const e = await assertLanca(() => carregarItensApriori(db), "erro do PostgREST");
  assertEquals(e.codigo, "54000", "o código do teto estourado não sobreviveu ao envelope");
  assert(
    !e.message.includes("40000000 bytes excede"),
    "a mensagem do Postgres vazou para o texto do erro — ela sai no CORPO da resposta HTTP",
  );
});

Deno.test("universo legitimamente vazio segue adiante (não é falha)", async () => {
  // O contrapeso dos testes acima: fail-closed que também rejeita o vazio LEGÍTIMO transformaria
  // "não há venda no recorte" em incidente. Vazio é `[]` com `total: 0`.
  const { db } = fakeDb(() => envelope([]));
  assertEquals(await carregarItensApriori(db), [], "o vazio legítimo não pode virar exceção");
});
