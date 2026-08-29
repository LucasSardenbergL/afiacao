// Testa o CÓDIGO REAL de `itens-com-pedido.ts` (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/itens-com-pedido_test.ts
//
// Sem import remoto (jsr:/npm:) — `test:edges` roda com `--no-remote` e BLOQUEIA o CI. O
// "banco" é um double que satisfaz `BancoPostgrest`, o contrato estrutural dos loaders
// (padrão de `recommend-leituras_test.ts` / `mapas-paginados_test.ts`).
//
// O QUE ESTE ARQUIVO PROVA. `fin-valor-cockpit/index.ts` e `omie-analytics-sync/index.ts`
// importam `npm:@supabase/supabase-js@2`, então NUNCA rodam sob `--no-remote`: enquanto a
// leitura morava lá dentro, "o item não é pulado sob DELETE concorrente" e "o pedido pai vem
// do MESMO instante que o item" eram afirmações sem execução. Extrair a leitura é o que as
// torna EXECUTÁVEIS.
//
// Os dois defeitos que a suíte fixa, e que são DIFERENTES:
//   1. DESLOCAMENTO por offset — `.range()` sob DELETE concorrente PULA linha viva. O teste
//      roda o MESMO cenário pelas duas paginações e exige que a por offset falhe: sem isso o
//      cenário poderia estar sem dente e o verde do keyset não significaria nada.
//   2. CRUZAMENTO de instantes — item e pedido pai lidos em DUAS paginações independentes
//      combinam linhas de instantes incompatíveis, e keyset nos dois lados não conserta
//      (cada um é consistente consigo, nenhum é consistente com o outro). Só some quando o
//      pai vem EMBEDADO na mesma linha, no mesmo request.
import { carregarItensApriori, carregarItensCockpit } from "./itens-com-pedido.ts";
import { FalhaLeituraCritica } from "./leitura-critica.ts";
import { fetchAll } from "./paginate.ts";
import type { BancoPostgrest, QueryPostgrest, RespostaPostgrest } from "./paginate.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

async function assertLanca(fn: () => Promise<unknown>, msg: string): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error(`${msg}: NÃO lançou — a falha foi engolida`);
}

type Linha = Record<string, unknown>;

// Registro do que a query PEDIU — é o que torna `.order()`/`.gt()`/`.select()` asserções de
// verdade. Olhar só o RESULTADO de um double que já devolve as páginas ordenadas deixaria
// passar um call-site sem ordem estável, que em prod pula/duplica linha entre páginas.
type Registro = {
  tabela: string;
  colunas: string;
  order: string | null;
  ascending: boolean | null;
  filtros: string[];
  ranges: Array<[number, number]>;
  limit: number | null;
};

// O double SIMULA O CAP DE 1.000 DO POSTGREST: sem `.range()`/`.limit()` ele corta em 1.000
// em silêncio, como o Data API real. Sem isto uma leitura NÃO paginada devolveria a tabela
// inteira no double e a suíte ficaria vazia.
const CAP_POSTGREST = 1000;

function fakeDb(
  tabelas: Record<string, Linha[]>,
  opts: {
    erroEm?: string;
    codigo?: string;
    nulaEm?: string;
    /** Roda DEPOIS de servir cada página. É o que torna a escrita CONCORRENTE: mutar antes
     *  de servir só mudaria o estado inicial, e a leitura nem perceberia. */
    aoServirPagina?: (tabela: string, pagina: number) => void;
  } = {},
) {
  const registros: Registro[] = [];
  const paginasServidas: Record<string, number> = {};

  function query(tabela: string): QueryPostgrest<Linha> {
    const reg: Registro = {
      tabela, colunas: "", order: null, ascending: null, filtros: [], ranges: [], limit: null,
    };
    registros.push(reg);
    const predicados: Array<(l: Linha) => boolean> = [];

    function corpo(): Linha[] {
      let linhas = (tabelas[tabela] ?? []).filter((l) => predicados.every((p) => p(l)));
      // `!inner` no embed DESCARTA a linha sem pai — o double aplica de verdade, senão a
      // asserção "o `!inner` é o que garante o pai" mediria uma promessa que o double
      // não cumpre.
      for (const emb of embedsInner(reg.colunas)) {
        linhas = linhas.filter((l) => l[emb] != null);
      }
      if (reg.order) {
        const col = reg.order;
        // Comparação `<`/`>` de String pura, NÃO `localeCompare`: a ordenação do Postgres
        // depende do collation, e um double que ordena por locale (pt_BR dobra acento)
        // classificaria diferente do servidor — o teste passaria a medir o ICU do Deno.
        linhas = [...linhas].sort((a, b) => {
          const x = String(a[col] ?? ""), y = String(b[col] ?? "");
          return (x < y ? -1 : x > y ? 1 : 0) * (reg.ascending === false ? -1 : 1);
        });
      }
      const alcance = reg.ranges[reg.ranges.length - 1];
      const servida = alcance
        ? linhas.slice(alcance[0], alcance[1] + 1)
        : linhas.slice(0, Math.min(reg.limit ?? CAP_POSTGREST, CAP_POSTGREST));
      if (opts.aoServirPagina) {
        paginasServidas[tabela] = (paginasServidas[tabela] ?? 0) + 1;
        opts.aoServirPagina(tabela, paginasServidas[tabela]);
      }
      return servida;
    }

    function resposta(): RespostaPostgrest<Linha> {
      if (opts.erroEm === tabela) {
        return { data: null, error: { message: "boom", code: opts.codigo ?? "57014" } };
      }
      // `data:null` SEM error é resposta MALFORMADA, não lista vazia — o EOF falso que a
      // família `fetchAll`/`fetchAllKeyset` existe para rejeitar.
      if (opts.nulaEm === tabela) return { data: null, error: null };
      return { data: corpo(), error: null };
    }

    const q: QueryPostgrest<Linha> = {
      select(colunas: string) { reg.colunas = colunas; return q; },
      eq(coluna: string, valor: unknown) {
        reg.filtros.push(`eq:${coluna}`);
        predicados.push((l) => l[coluna] === valor);
        return q;
      },
      in(coluna: string, valores: readonly unknown[]) {
        const alvo = new Set(valores);
        reg.filtros.push(`in:${coluna}=${valores.length}`);
        predicados.push((l) => alvo.has(l[coluna]));
        return q;
      },
      gt(coluna: string, valor: unknown) {
        reg.filtros.push(`gt:${coluna}`);
        // STRING e não Number: a chave do keyset é `id` (uuid), e `Number(uuid)` é NaN —
        // todo predicado viraria falso e a suíte ficaria verde por não devolver nada.
        predicados.push((l) => String(l[coluna] ?? "") > String(valor));
        return q;
      },
      gte(coluna: string, valor: unknown) {
        reg.filtros.push(`gte:${coluna}`);
        // `created_at` é DATE/timestamp em ISO — comparação de string é cronológica.
        predicados.push((l) => String(l[coluna] ?? "") >= String(valor));
        return q;
      },
      lt(coluna: string, valor: unknown) {
        reg.filtros.push(`lt:${coluna}`);
        predicados.push((l) => String(l[coluna] ?? "") < String(valor));
        return q;
      },
      not(coluna: string, operador: string, _valor: unknown) {
        // Registrado e NÃO aplicado: o filtro real é do PostgREST sobre coluna do embed. O
        // que a suíte afirma aqui é que o call-site PEDE o filtro — o efeito dele é do
        // servidor, e um double que fingisse aplicá-lo estaria provando o double.
        reg.filtros.push(`not:${coluna} ${operador}`);
        return q;
      },
      is(coluna: string, valor: unknown) {
        reg.filtros.push(`is:${coluna}`);
        predicados.push((l) => (l[coluna] ?? null) === valor);
        return q;
      },
      order(coluna: string, o?: { ascending?: boolean }) {
        reg.order = coluna;
        reg.ascending = o?.ascending ?? true;
        return q;
      },
      range(de: number, ate: number) { reg.ranges.push([de, ate]); return q; },
      limit(n: number) { reg.limit = n; return q; },
      maybeSingle() {
        const r = resposta();
        return Promise.resolve(
          r.error ? { data: null, error: r.error } : { data: (r.data ?? [])[0] ?? null, error: null },
        );
      },
      then<R1, R2>(
        resolve?: ((v: RespostaPostgrest<Linha>) => R1 | PromiseLike<R1>) | null,
        rejeitar?: ((motivo: unknown) => R2 | PromiseLike<R2>) | null,
      ): PromiseLike<R1 | R2> {
        return Promise.resolve(resposta()).then(resolve, rejeitar);
      },
    };
    return q;
  }

  const db = {
    from: <T>(tabela: string) => query(tabela) as unknown as QueryPostgrest<T>,
    rpc: <T>(_fn: string, _args: Record<string, unknown>) =>
      Promise.resolve({ data: null as T[] | null, error: { message: "rpc não usada aqui" } }),
  } as unknown as BancoPostgrest;

  return { db, registros, tabelas };
}

/** Nomes dos embeds marcados `!inner` no texto do `.select()` (`sales_orders!inner(...)`). */
function embedsInner(colunas: string): string[] {
  const out: string[] = [];
  const re = /([a-z_]+)!inner\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(colunas)) !== null) out.push(m[1]);
  return out;
}

// ── Universo sintético ────────────────────────────────────────────────────────────────
// 2.300 itens ⇒ 3 páginas de 1.000 (a 3ª curta, a 4ª vazia): passa da primeira fronteira de
// página, que é onde o deslocamento por offset se materializa.
const TOTAL = 2300;
const ALVO = 1000; // primeira linha da 2ª página — a que o offset pula quando a 1ª encolhe
const VALOR_ALVO = 1_000_000;

function id(i: number): string {
  return `i-${String(i).padStart(6, "0")}`;
}

function universoCockpit(): Record<string, Linha[]> {
  const itens: Linha[] = [];
  for (let i = 0; i < TOTAL; i++) {
    itens.push({
      id: id(i),
      customer_user_id: `u-${i % 7}`,
      product_id: `p-${i % 11}`,
      omie_codigo_produto: 1000 + (i % 11),
      quantity: 1,
      unit_price: i === ALVO ? VALOR_ALVO : 10,
      discount: 0,
      sales_order_id: `so-${i}`,
      created_at: "2026-01-01",
      // O pai EMBEDADO — é assim que o PostgREST devolve um to-one com `!inner`.
      sales_orders: {
        status: "faturado",
        deleted_at: null,
        order_date_kpi: "2026-01-01",
        account: "oben",
        origem: "app",
        checkout_id: null,
      },
    });
  }
  return { order_items: itens };
}

Deno.test("cockpit: pagina por KEYSET — `id` no select, `.order('id')` ascendente e `.gt` a partir da 2ª página", async () => {
  const { db, registros } = fakeDb(universoCockpit());
  const linhas = await carregarItensCockpit(db, "2025-01-01");

  assertEquals(linhas.length, TOTAL, "a leitura não devolveu o universo inteiro");

  const paginas = registros.filter((r) => r.tabela === "order_items");
  assert(paginas.length >= 3, `esperava ≥3 páginas, veio ${paginas.length}`);
  for (const [i, p] of paginas.entries()) {
    // A coluna do cursor TEM de estar projetada: sob `.range()` ela não precisava, e o
    // typecheck não pega a falta (o `.select()` é string e a interface PROMETE o campo) —
    // só o runtime descobriria, com o cursor virando `undefined`.
    assert(/(^|[\s,])id([\s,]|$)/.test(p.colunas), `página ${i + 1}: \`id\` fora do .select() → ${p.colunas}`);
    assertEquals(p.order, "id", `página ${i + 1}: .order() não é por \`id\``);
    assertEquals(p.ascending, true, `página ${i + 1}: keyset exige .order() ASCENDENTE`);
    assertEquals(p.ranges.length, 0, `página ${i + 1}: ainda usa .range() — offset desloca sob escrita`);
    assert(p.limit !== null, `página ${i + 1}: keyset sem .limit()`);
    // Página 1 não tem cursor; da 2ª em diante o `.gt` é o que impede a releitura.
    const temGt = p.filtros.some((f) => f === "gt:id");
    assertEquals(temGt, i > 0, `página ${i + 1}: .gt('id') ${i > 0 ? "ausente" : "presente sem cursor"}`);
  }
});

Deno.test("cockpit: DELETE concorrente NÃO pula linha viva — e o mesmo cenário por offset PULA", async () => {
  // O dente do cenário. Sem a metade `offset`, um verde do keyset não distinguiria
  // "a paginação resistiu" de "o cenário não deslocava nada".
  const alvoId = id(ALVO);

  // ── metade 1: keyset (o código real) ──
  const k = fakeDb(universoCockpit(), {
    aoServirPagina: (tabela, pagina) => {
      // Hard DELETE de uma linha JÁ LIDA (índice 5, da 1ª página) logo depois de servi-la —
      // é o `sync-reprocess` (`.delete().in('id', diff.deletar)`) rodando 15 */2 * * *,
      // inclusive em horário comercial, enquanto o cockpit lê.
      if (tabela === "order_items" && pagina === 1) {
        k.tabelas.order_items.splice(5, 1);
      }
    },
  });
  const comKeyset = await carregarItensCockpit(k.db, "2025-01-01");
  assert(
    comKeyset.some((l) => l.id === alvoId),
    `KEYSET pulou a linha viva de R$ ${VALOR_ALVO} (${alvoId}) — o deslocamento não foi eliminado`,
  );

  // ── metade 2: offset, o código que estava em produção ──
  const o = fakeDb(universoCockpit(), {
    aoServirPagina: (tabela, pagina) => {
      if (tabela === "order_items" && pagina === 1) o.tabelas.order_items.splice(5, 1);
    },
  });
  const comOffset = await fetchAll<{ id: string }>(
    (de, ate) =>
      o.db.from<{ id: string }>("order_items")
        .select("id, unit_price, sales_order_id")
        .order("id", { ascending: true })
        .range(de, ate),
    "order_items",
  );
  assert(
    !comOffset.some((l) => l.id === alvoId),
    "o cenário está SEM DENTE: nem por offset a linha some — o teste não prova nada",
  );
  // Por que checagem de CONTAGEM não serve de guard, que é o núcleo do achado da revisão
  // independente: o offset devolveu EXATAMENTE tantas linhas quanto a tabela tem ao fim da
  // leitura — o número que um guard ingênuo compararia — e mesmo assim omitiu a linha viva
  // de R$ 1.000.000. A contagem parece certa porque a linha PULADA e a linha DELETADA se
  // cancelam no total; a identidade é que está trocada, e nenhum total a denuncia.
  assertEquals(
    comOffset.length,
    o.tabelas.order_items.length,
    "o cenário mudou: o offset deixou de fechar a contagem, e é o FECHAR que torna o defeito invisível",
  );
  // O keyset devolve UMA a mais que a tabela final — a linha que ele já tinha lido quando o
  // DELETE aconteceu. Não é bug: é o que "li tudo que existia quando passei por ali"
  // significa sem snapshot. O que ele não faz é PULAR o que estava lá o tempo todo.
  assertEquals(comKeyset.length, o.tabelas.order_items.length + 1, "o keyset perdeu ou duplicou linha");
});

Deno.test("cockpit: o pedido pai vem EMBEDADO — `sales_orders` nunca é uma segunda paginação", async () => {
  const { db, registros } = fakeDb(universoCockpit());
  const linhas = await carregarItensCockpit(db, "2025-01-01");

  // O invariante da CONSULTA ÚNICA. Dois keysets separados (um em `order_items`, outro em
  // `sales_orders`) resolvem o deslocamento de cada lado e mesmo assim combinam pai e filho
  // de instantes incompatíveis — o cruzamento em memória é o defeito, não a paginação.
  assertEquals(
    registros.filter((r) => r.tabela === "sales_orders").length,
    0,
    "`sales_orders` foi lida em separado — o cruzamento voltou a ser entre DOIS instantes",
  );
  assert(
    registros.every((r) => r.tabela === "order_items"),
    `tabela inesperada: ${[...new Set(registros.map((r) => r.tabela))].join(", ")}`,
  );
  assert(
    registros[0].colunas.includes("sales_orders!inner("),
    `o embed do pai não é \`!inner\` → ${registros[0].colunas}`,
  );
  // O pai chega em cada linha, e é dele que saem janela (order_date_kpi), faturabilidade
  // (status/deleted_at), recorte de conta (account) e canal (origem/checkout_id).
  assertEquals(linhas[0].sales_orders?.order_date_kpi, "2026-01-01");
  assertEquals(linhas[0].sales_orders?.account, "oben");
});

Deno.test("cockpit: item SEM pedido pai é descartado pelo `!inner` (não vira linha órfã no cálculo)", async () => {
  const u = universoCockpit();
  (u.order_items[3] as Linha).sales_orders = null;
  const { db } = fakeDb(u);
  const linhas = await carregarItensCockpit(db, "2025-01-01");
  assertEquals(linhas.length, TOTAL - 1, "o `!inner` não descartou o item sem pai");
  assert(!linhas.some((l) => l.id === id(3)), "o item órfão entrou no resultado");
});

Deno.test("cockpit: página com erro LANÇA FalhaLeituraCritica — nunca devolve o parcial", async () => {
  const { db } = fakeDb(universoCockpit(), { erroEm: "order_items", codigo: "57014" });
  const e = await assertLanca(() => carregarItensCockpit(db, "2025-01-01"), "erro de página");
  assert(e instanceof FalhaLeituraCritica, `esperava FalhaLeituraCritica, veio ${e.constructor.name}`);
  // Domínio FECHADO: o MESSAGE do Postgres interpola valor de LINHA e o `catch` do
  // `Deno.serve` devolve `.message` no CORPO da resposta HTTP.
  assert(!e.message.includes("boom"), `o texto do servidor vazou na mensagem pública: ${e.message}`);
});

Deno.test("cockpit: resposta MALFORMADA (data:null sem error) LANÇA — não é fim da tabela", async () => {
  const { db } = fakeDb(universoCockpit(), { nulaEm: "order_items" });
  const e = await assertLanca(() => carregarItensCockpit(db, "2025-01-01"), "resposta malformada");
  assert(e instanceof FalhaLeituraCritica, `esperava FalhaLeituraCritica, veio ${e.constructor.name}`);
});

Deno.test("LIMITE CONHECIDO: keyset não é snapshot — INSERT atrás do cursor NÃO aparece", async () => {
  // Este teste afirma o comportamento REAL, não o desejado. A revisão independente nomeou
  // que a suíte de keyset exige "sem duplicata" e NÃO exige que o insert apareça — então o
  // nome do arquivo sugeria uma garantia que o código não dá. Fica escrito aqui, com dente:
  // se alguém trocar por uma leitura que DÊ snapshot (RPC transacional), este teste fica
  // vermelho e obriga a decisão a ser revista em vez de herdada.
  //
  // Por que é ACEITÁVEL no cockpit e no Apriori: o que some é linha NASCIDA durante a
  // leitura (segundos), num relatório de janela TTM — perda de recall recente. O que o
  // keyset elimina é o outro dano, o grave: linha ANTIGA e viva PULADA por deslocamento,
  // que muda um número já fechado. Precisão > recall (money-path §2).
  const u = universoCockpit();
  const inserido = "i-000500x"; // atrás do cursor da 1ª página (que termina em i-000999)
  const { db, tabelas } = fakeDb(u, {
    aoServirPagina: (tabela, pagina) => {
      if (tabela === "order_items" && pagina === 1) {
        tabelas.order_items.push({
          ...(u.order_items[0] as Linha),
          id: inserido,
          unit_price: 999,
        });
      }
    },
  });
  const linhas = await carregarItensCockpit(db, "2025-01-01");
  assert(
    !linhas.some((l) => l.id === inserido),
    "o insert atrás do cursor APARECEU — o comportamento mudou e a decisão precisa ser revista",
  );
  // E o que ele NÃO faz: duplicar. Nenhuma linha volta duas vezes.
  assertEquals(new Set(linhas.map((l) => l.id)).size, linhas.length, "houve duplicata entre páginas");
});

Deno.test("cockpit: o prefiltro de `created_at` continua sendo aplicado em TODA página", async () => {
  const u = universoCockpit();
  (u.order_items[7] as Linha).created_at = "2020-01-01"; // fora da janela de prefetch
  const { db, registros } = fakeDb(u);
  const linhas = await carregarItensCockpit(db, "2025-01-01");
  assertEquals(linhas.length, TOTAL - 1, "o prefiltro de created_at não filtrou");
  assert(
    registros.filter((r) => r.tabela === "order_items").every((r) => r.filtros.includes("gte:created_at")),
    "alguma página perdeu o `.gte('created_at')` — o recorte muda no meio da leitura",
  );
});

// ── Apriori (omie-analytics-sync) ─────────────────────────────────────────────────────

function universoApriori(): Record<string, Linha[]> {
  const itens: Linha[] = [];
  for (let i = 0; i < TOTAL; i++) {
    itens.push({
      id: id(i),
      sales_order_id: `so-${i}`,
      product_id: `p-${i % 11}`,
      sales_orders: { status: "faturado", deleted_at: null, account: i % 2 ? "oben" : "colacor" },
    });
  }
  return { order_items: itens };
}

Deno.test("apriori: pagina por KEYSET e mantém os filtros do universo em TODA página", async () => {
  const { db, registros } = fakeDb(universoApriori());
  const linhas = await carregarItensApriori(db);

  assertEquals(linhas.length, TOTAL, "o universo Apriori não voltou inteiro");
  const paginas = registros.filter((r) => r.tabela === "order_items");
  assert(paginas.length >= 3, `esperava ≥3 páginas, veio ${paginas.length}`);
  for (const [i, p] of paginas.entries()) {
    assert(/(^|[\s,])id([\s,]|$)/.test(p.colunas), `página ${i + 1}: \`id\` fora do .select()`);
    assertEquals(p.order, "id", `página ${i + 1}: .order() não é por \`id\``);
    assertEquals(p.ascending, true, `página ${i + 1}: keyset exige ascendente`);
    assertEquals(p.ranges.length, 0, `página ${i + 1}: ainda usa .range()`);
    assertEquals(p.filtros.some((f) => f === "gt:id"), i > 0, `página ${i + 1}: cursor .gt('id')`);
    // As três metades do universo (produto vinculado + status de venda + não-apagado)
    // valem por PÁGINA: perder uma no meio troca o universo publicado GLOBALMENTE.
    assert(p.filtros.includes("not:product_id is"), `página ${i + 1}: perdeu o filtro de product_id`);
    assert(p.filtros.includes("not:sales_orders.status in"), `página ${i + 1}: perdeu a denylist de status`);
    assert(p.filtros.includes("is:sales_orders.deleted_at"), `página ${i + 1}: perdeu o deleted_at IS NULL`);
  }
  assert(
    registros[0].colunas.includes("sales_orders!inner("),
    `o embed do pai não é \`!inner\` → ${registros[0].colunas}`,
  );
});

Deno.test("apriori: DELETE concorrente NÃO pula linha viva", async () => {
  const alvoId = id(ALVO);
  const a = fakeDb(universoApriori(), {
    aoServirPagina: (tabela, pagina) => {
      if (tabela === "order_items" && pagina === 1) a.tabelas.order_items.splice(5, 1);
    },
  });
  const linhas = await carregarItensApriori(a.db);
  assert(linhas.some((l) => l.id === alvoId), `o universo Apriori pulou ${alvoId} sob DELETE concorrente`);
});

Deno.test("apriori: página com erro LANÇA FalhaLeituraCritica", async () => {
  const { db } = fakeDb(universoApriori(), { erroEm: "order_items", codigo: "42501" });
  const e = await assertLanca(() => carregarItensApriori(db), "erro de página");
  assert(e instanceof FalhaLeituraCritica, `esperava FalhaLeituraCritica, veio ${e.constructor.name}`);
});
