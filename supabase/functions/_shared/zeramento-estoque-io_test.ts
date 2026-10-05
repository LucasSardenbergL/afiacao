// Testa o I/O REAL de zeramento-estoque-io.ts no runtime real (Deno): loaders keyset, o UPDATE com
// CAS e o orquestrador. Roda com: deno test --no-remote supabase/functions/_shared/zeramento-estoque-io_test.ts
//
// O double APLICA os filtros (leitura e escrita) sobre tabelas em memória: um double que só
// registrasse a chamada aprovaria um UPDATE sem CAS, ou contaria como "zerado" a linha que o CAS
// recusou (Codex, desenho de 2026-10-05: "CAS não atualiza nenhuma linha → zerados = 0, não o
// tamanho do lote planejado").
import type { BancoPostgrest } from "./paginate.ts";
import { FalhaLeituraCritica } from "./leitura-critica.ts";
import {
  aplicarEscritaConfirmada,
  carregarEstoqueLocalNaoZero,
  carregarPosicoesLocaisNaoZero,
  type EscritorPostgrest,
  metadataDoZeramento,
  zerarConfirmadosForaDaLista,
} from "./zeramento-estoque-io.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

type Linha = Record<string, unknown>;
type Leitura = { tabela: string; colunas: string; filtros: string[]; order: string | null; limit: number | null };
type Escrita = { tabela: string; set: Linha; filtros: string[]; colunas: string };

function igual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return a === b;
}

// Só os métodos que o módulo usa; método ausente vira TypeError (falha alta), nunca verde por omissão.
function fakeDb(
  tabelas: Record<string, Linha[]>,
  opts: { erroNaLeitura?: number; erroNaEscrita?: (e: Escrita) => boolean; aposLeituras?: () => void } = {},
) {
  const leituras: Leitura[] = [];
  const escritas: Escrita[] = [];
  let nLeitura = 0;
  function ler(tabela: string) {
    const pg: Leitura = { tabela, colunas: "", filtros: [], order: null, limit: null };
    leituras.push(pg);
    const n = ++nLeitura;
    const preds: Array<(l: Linha) => boolean> = [];
    const q = {
      select(c: string) { pg.colunas = c; return q; },
      eq(col: string, v: unknown) { pg.filtros.push(`eq:${col}=${String(v)}`); preds.push((l) => igual(l[col], v)); return q; },
      not(col: string, op: string, v: unknown) {
        pg.filtros.push(`not:${col} ${op} ${String(v)}`);
        if (op !== "eq") throw new Error(`double: .not(_, ${op}) não implementado`);
        preds.push((l) => l[col] !== null && l[col] !== undefined && !igual(l[col], v)); // NOT(col = v): NULL não passa
        return q;
      },
      gt(col: string, v: unknown) { pg.filtros.push(`gt:${col}`); preds.push((l) => String(l[col]) > String(v)); return q; },
      in(col: string, vs: readonly unknown[]) { pg.filtros.push(`in:${col}=${vs.join(",")}`); preds.push((l) => vs.some((v) => igual(l[col], v))); return q; },
      order(col: string) { pg.order = col; return q; },
      limit(n: number) { pg.limit = n; return q; },
      then<R>(resolve: (v: { data: Linha[] | null; error: { message: string; code: string } | null }) => R) {
        if (opts.erroNaLeitura === n) return Promise.resolve(resolve({ data: null, error: { message: "timeout", code: "57014" } }));
        const linhas = (tabelas[tabela] ?? []).filter((l) => preds.every((p) => p(l)));
        const ord = pg.order ? [...linhas].sort((a, b) => (String(a[pg.order!]) < String(b[pg.order!]) ? -1 : 1)) : linhas;
        const data = ord.slice(0, pg.limit ?? ord.length).map((l) => ({ ...l }));
        return Promise.resolve(resolve({ data, error: null }));
      },
    };
    return q;
  }
  function escrever(tabela: string, set: Linha) {
    const e: Escrita = { tabela, set, filtros: [], colunas: "" };
    escritas.push(e);
    const preds: Array<(l: Linha) => boolean> = [];
    const f = {
      eq(col: string, v: unknown) { e.filtros.push(`eq:${col}=${String(v)}`); preds.push((l) => igual(l[col], v)); return f; },
      is(col: string, v: null) { e.filtros.push(`is:${col}=${String(v)}`); preds.push((l) => l[col] === v); return f; },
      neq(col: string, v: unknown) {
        e.filtros.push(`neq:${col}=${String(v)}`);
        preds.push((l) => l[col] !== null && l[col] !== undefined && !igual(l[col], v)); // col <> v: NULL não passa
        return f;
      },
      select(c: string) {
        e.colunas = c;
        if (opts.erroNaEscrita?.(e)) return Promise.resolve({ data: null, error: { message: "falha simulada", code: "XX000" } });
        const alvo = (tabelas[tabela] ?? []).filter((l) => preds.every((p) => p(l)));
        for (const l of alvo) Object.assign(l, set);
        return Promise.resolve({ data: alvo.map((l) => ({ ...l })), error: null });
      },
    };
    return f;
  }
  const leitor = { from: (t: string) => ler(t) } as unknown as BancoPostgrest;
  const escritor = { from: (t: string) => ({ update: (v: Linha) => escrever(t, v) }) } as unknown as EscritorPostgrest;
  return { leitor, escritor, leituras, escritas };
}

const NOW = "2026-10-05T13:00:00.000Z";

function posicao(id: string, account: string, cod: number, saldo: unknown, synced_at: string | null, cmc: unknown = 796.21): Linha {
  return { id, account, omie_codigo_produto: cod, saldo, cmc, preco_medio: 800, synced_at };
}

// ════════ loaders ════════

Deno.test("carregarPosicoesLocaisNaoZero — só a conta e saldo ≠ 0, atravessando a página de 1.000, keyset por id", async () => {
  const linhas: Linha[] = [];
  for (let i = 0; i < 1100; i++) linhas.push(posicao(`v${String(i).padStart(5, "0")}`, "vendas", i + 1, i % 2 ? 3 : -1, null));
  for (let i = 0; i < 50; i++) linhas.push(posicao(`z${String(i).padStart(5, "0")}`, "vendas", 5000 + i, 0, null));
  linhas.push(posicao("n00000", "vendas", 9000, null, null));
  linhas.push(posicao("o00000", "oben", 9001, 8, null));
  const { leitor, leituras } = fakeDb({ inventory_position: linhas });
  const out = await carregarPosicoesLocaisNaoZero(leitor, ["vendas"]);
  assertEquals(out.length, 1100);
  assertEquals(leituras.length, 3); // 1.000 + 100 + a página vazia que encerra
  for (const pg of leituras) {
    assertEquals(pg.tabela, "inventory_position");
    assertEquals(pg.colunas, "id, account, omie_codigo_produto, saldo, cmc, preco_medio, synced_at");
    assertEquals(pg.filtros.slice(0, 2), ["in:account=vendas", "not:saldo eq 0"]);
    assertEquals([pg.order, pg.limit], ["id", 1000]);
  }
  assertEquals(leituras.map((p) => p.filtros.includes("gt:id")), [false, true, true]);
});

Deno.test("carregarPosicoesLocaisNaoZero — página com erro LANÇA FalhaLeituraCritica (nunca vira lista vazia)", async () => {
  const { leitor } = fakeDb({ inventory_position: [posicao("a", "vendas", 1, 2, null)] }, { erroNaLeitura: 1 });
  let capturado: unknown = null;
  try {
    await carregarPosicoesLocaisNaoZero(leitor, ["vendas"]);
  } catch (e) {
    capturado = e;
  }
  assertEquals(capturado instanceof FalhaLeituraCritica, true);
});

Deno.test("carregarEstoqueLocalNaoZero — só a empresa e estoque ≠ 0, só as colunas do UPDATE por id", async () => {
  const { leitor, leituras } = fakeDb({
    omie_products: [
      { id: "p1", account: "oben", omie_codigo_produto: 1, estoque: 3 },
      { id: "p2", account: "oben", omie_codigo_produto: 2, estoque: 0 },
      { id: "p3", account: "colacor", omie_codigo_produto: 3, estoque: 9 },
    ],
  });
  const out = await carregarEstoqueLocalNaoZero(leitor, "oben");
  assertEquals(out.map((l) => l.id), ["p1"]);
  assertEquals(leituras[0].colunas, "id, omie_codigo_produto, estoque, updated_at");
  assertEquals(leituras[0].filtros.slice(0, 2), ["eq:account=oben", "not:estoque eq 0"]);
});

// ════════ escrita com CAS ════════

Deno.test("aplicar — UPDATE da posição só com o SET planejado e o CAS do saldo e do synced_at lidos", async () => {
  const tab = { inventory_position: [posicao("a", "vendas", 7, 2.43, "2026-08-27T11:15:33.796+00:00")] };
  const { escritor, escritas } = fakeDb(tab);
  const r = await aplicarEscritaConfirmada(escritor, null, {
    posicoes: [{ account: "vendas", omie_codigo_produto: 7, casSyncedAt: "2026-08-27T11:15:33.796+00:00", set: { saldo: 0, synced_at: NOW } }],
    estoque: [],
  });
  assertEquals(escritas[0].tabela, "inventory_position");
  assertEquals(escritas[0].set, { saldo: 0, synced_at: NOW });
  assertEquals(escritas[0].filtros, [
    "eq:account=vendas",
    "eq:omie_codigo_produto=7",
    "neq:saldo=0",
    "eq:synced_at=2026-08-27T11:15:33.796+00:00",
  ]);
  assertEquals([r.posicoesZeradas, r.recusadosCas, r.falhas], [1, 0, []]);
  assertEquals([tab.inventory_position[0].saldo, tab.inventory_position[0].cmc], [0, 796.21]);
});

Deno.test("aplicar — synced_at lido null vira `.is(synced_at, null)`, nunca `eq.null`", async () => {
  const { escritor, escritas } = fakeDb({ inventory_position: [posicao("a", "vendas", 7, 2, null)] });
  const r = await aplicarEscritaConfirmada(escritor, null, {
    posicoes: [{ account: "vendas", omie_codigo_produto: 7, casSyncedAt: null, set: { saldo: 0 } }],
    estoque: [],
  });
  assertEquals(escritas[0].filtros.at(-1), "is:synced_at=null");
  assertEquals(r.posicoesZeradas, 1);
});

Deno.test("aplicar — linha que MUDOU depois da leitura: o CAS recusa, conta como recusada e não como zerada", async () => {
  const tab = { inventory_position: [posicao("a", "vendas", 7, 5, "2026-10-05T12:59:00Z")] }; // o dono regravou
  const { escritor } = fakeDb(tab);
  const r = await aplicarEscritaConfirmada(escritor, null, {
    posicoes: [{ account: "vendas", omie_codigo_produto: 7, casSyncedAt: "2026-08-27T00:00:00Z", set: { saldo: 0 } }],
    estoque: [],
  });
  assertEquals([r.posicoesZeradas, r.recusadosCas], [0, 1]);
  assertEquals(tab.inventory_position[0].saldo, 5);
});

Deno.test("aplicar — catálogo: UPDATE por id + empresa + CAS do estoque lido, SET só do estoque", async () => {
  const tab = { omie_products: [{ id: "p1", account: "oben", omie_codigo_produto: 7, estoque: 2.43, codigo: "WP07", descricao: "X", updated_at: "2026-10-05T08:33:05.1+00:00" }] };
  const { escritor, escritas } = fakeDb(tab);
  const r = await aplicarEscritaConfirmada(escritor, "oben", {
    posicoes: [],
    estoque: [{ id: "p1", omie_codigo_produto: 7, casUpdatedAt: "2026-10-05T08:33:05.1+00:00", set: { estoque: 0 } }],
  });
  assertEquals(escritas[0].tabela, "omie_products");
  assertEquals(escritas[0].set, { estoque: 0 });
  assertEquals(escritas[0].filtros, ["eq:id=p1", "eq:account=oben", "neq:estoque=0", "eq:updated_at=2026-10-05T08:33:05.1+00:00"]);
  assertEquals([r.estoqueZerado, r.recusadosCas], [1, 0]);
  assertEquals([tab.omie_products[0].estoque, tab.omie_products[0].codigo], [0, "WP07"]);
});

Deno.test("aplicar — erro de escrita vira falha com o código, nunca zerado; as demais linhas seguem", async () => {
  const tab = { inventory_position: [posicao("a", "vendas", 7, 2, null), posicao("b", "vendas", 8, 3, null)] };
  const { escritor } = fakeDb(tab, { erroNaEscrita: (e) => e.filtros.includes("eq:omie_codigo_produto=7") });
  const r = await aplicarEscritaConfirmada(escritor, null, {
    posicoes: [
      { account: "vendas", omie_codigo_produto: 7, casSyncedAt: null, set: { saldo: 0 } },
      { account: "vendas", omie_codigo_produto: 8, casSyncedAt: null, set: { saldo: 0 } },
    ],
    estoque: [],
  });
  assertEquals([r.posicoesZeradas, r.recusadosCas, r.falhas.length], [1, 0, 1]);
  assertEquals(r.falhas[0].includes("XX000"), true, r.falhas[0]);
  assertEquals(tab.inventory_position[0].saldo, 2);
});

// ════════ orquestrador ════════

function cenario() {
  return {
    inventory_position: [
      posicao("a", "vendas", 7, 2.43, "2026-08-27T11:15:33.796+00:00"), // congelada: o Omie diz 0
      posicao("b", "vendas", 101, 4, "2026-10-05T12:30:00Z"), // deslizou da paginação: o Omie diz 4
      posicao("c", "vendas", 1, 5, "2026-10-05T12:59:00Z"), // listada
    ],
    omie_products: [
      { id: "p7", account: "oben", omie_codigo_produto: 7, estoque: 2.43, updated_at: "2026-10-05T08:33:05.1+00:00" },
      { id: "p1", account: "oben", omie_codigo_produto: 1, estoque: 5, updated_at: "2026-10-05T08:33:05.1+00:00" },
    ],
  };
}

Deno.test("orquestrador — confirma em lote, zera o confirmado nas duas tabelas e deixa o positivo deslizado", async () => {
  const tab = cenario();
  const { leitor, escritor } = fakeDb(tab);
  const pedidos: Array<Record<string, unknown>> = [];
  const r = await zerarConfirmadosForaDaLista({
    leitor,
    escritor,
    chamarOmie: (p) => {
      pedidos.push(p);
      return Promise.resolve({ produtos: [{ nCodProd: 7, nSaldo: 0, nCMC: 796.21, nPrecoMedio: 800 }, { nCodProd: 101, nSaldo: 4, nCMC: 9 }] });
    },
    account: "vendas",
    empresa: "oben",
    listados: new Set([1]),
    completude: { completa: true },
    dataPosicao: "05/10/2026",
    nowIso: NOW,
  });
  assertEquals(pedidos.length, 1);
  assertEquals([pedidos[0].cExibeTodos, pedidos[0].dDataPosicao, pedidos[0].lista_produtos], ["S", "05/10/2026", [{ nCodProd: 7 }, { nCodProd: 101 }]]);
  assertEquals([tab.inventory_position[0].saldo, tab.inventory_position[0].synced_at], [0, NOW]);
  assertEquals(tab.inventory_position[1].saldo, 4);
  assertEquals(tab.omie_products[0].estoque, 0);
  assertEquals(tab.omie_products[1].estoque, 5);
  assertEquals(r, {
    candidatos: 2,
    confirmadosZero: 1,
    naoZero: 1,
    desconhecidos: 0,
    posicoesZeradas: 1,
    estoqueZerado: 1,
    recusadosCas: 0,
    chamadasConfirmacao: 1,
    estranhosNaConfirmacao: 0,
    pulado: null,
    falhas: [],
  });
});

Deno.test("orquestrador — confirmação que FALHA não zera ninguém e registra a falha", async () => {
  const tab = cenario();
  const { leitor, escritor } = fakeDb(tab);
  const r = await zerarConfirmadosForaDaLista({
    leitor,
    escritor,
    chamarOmie: () => Promise.reject(new Error("Omie (vendas): Consumo redundante")),
    account: "vendas",
    empresa: "oben",
    listados: new Set([1]),
    completude: { completa: true },
    dataPosicao: "05/10/2026",
    nowIso: NOW,
  });
  assertEquals([r.confirmadosZero, r.desconhecidos, r.posicoesZeradas, r.estoqueZerado], [0, 2, 0, 0]);
  assertEquals(r.falhas.length, 1);
  assertEquals(r.falhas[0].includes("Consumo redundante"), true, r.falhas[0]);
  assertEquals([tab.inventory_position[0].saldo, tab.omie_products[0].estoque], [2.43, 2.43]);
});

Deno.test("orquestrador — resposta sem lista de produtos é falha, não 'nenhum produto'", async () => {
  const tab = cenario();
  const { leitor, escritor } = fakeDb(tab);
  const r = await zerarConfirmadosForaDaLista({
    leitor,
    escritor,
    chamarOmie: () => Promise.resolve({ nTotPaginas: 1 }),
    account: "vendas",
    empresa: "oben",
    listados: new Set([1]),
    completude: { completa: true },
    dataPosicao: "05/10/2026",
    nowIso: NOW,
  });
  assertEquals([r.confirmadosZero, r.desconhecidos, r.falhas.length], [0, 2, 1]);
  assertEquals(tab.inventory_position[0].saldo, 2.43);
});

Deno.test("orquestrador — listagem incompleta: NENHUMA chamada ao Omie e o motivo sai em `pulado`", async () => {
  const tab = cenario();
  const { leitor, escritor } = fakeDb(tab);
  let chamadas = 0;
  const r = await zerarConfirmadosForaDaLista({
    leitor,
    escritor,
    chamarOmie: () => {
      chamadas++;
      return Promise.resolve({ produtos: [] });
    },
    account: "vendas",
    empresa: "oben",
    listados: new Set([1]),
    completude: { completa: false, motivo: "última página cheia (100) — pode haver continuação" },
    dataPosicao: "05/10/2026",
    nowIso: NOW,
  });
  assertEquals([chamadas, r.chamadasConfirmacao, r.candidatos], [0, 0, 2]);
  assertEquals(r.pulado !== null && r.pulado.includes("última página cheia"), true, String(r.pulado));
});

Deno.test("orquestrador — conta sem catálogo (empresa null): só a posição, o catálogo nem é lido", async () => {
  const tab = { inventory_position: [posicao("s", "servicos", 7, 3, null)], omie_products: [{ id: "p7", account: "colacor", omie_codigo_produto: 7, estoque: 3, updated_at: "x" }] };
  const { leitor, escritor, leituras } = fakeDb(tab);
  const r = await zerarConfirmadosForaDaLista({
    leitor,
    escritor,
    chamarOmie: () => Promise.resolve({ produtos: [{ nCodProd: 7, nSaldo: 0 }] }),
    account: "servicos",
    empresa: null,
    listados: new Set([1]),
    completude: { completa: true },
    dataPosicao: "05/10/2026",
    nowIso: NOW,
  });
  assertEquals(leituras.some((l) => l.tabela === "omie_products"), false);
  assertEquals([r.posicoesZeradas, r.estoqueZerado], [1, 0]);
  assertEquals([tab.inventory_position[0].saldo, tab.omie_products[0].estoque], [0, 3]);
});

// ════════ metadata ════════

Deno.test("metadata — o passo que não rodou (loader falhou) é null, nunca 0, e leva o erro", () => {
  assertEquals(metadataDoZeramento(null, "inventory_position (saldo≠0): 57014"), {
    zeramento_candidatos: null,
    zeramento_erro: "inventory_position (saldo≠0): 57014",
  });
});

Deno.test("metadata — rodada apurada: contagens em snake_case; pulado e falhas só quando existem", () => {
  const base = {
    candidatos: 3, confirmadosZero: 1, naoZero: 1, desconhecidos: 1, posicoesZeradas: 1, estoqueZerado: 1,
    recusadosCas: 0, chamadasConfirmacao: 1, estranhosNaConfirmacao: 0, pulado: null, falhas: [] as string[],
  };
  assertEquals(metadataDoZeramento(base, null), {
    zeramento_candidatos: 3,
    zeramento_confirmados_zero: 1,
    zeramento_nao_zero: 1,
    zeramento_desconhecidos: 1,
    zerados_posicao: 1,
    zerados_estoque: 1,
    zeramento_recusados_cas: 0,
    zeramento_chamadas: 1,
    zeramento_estranhos: 0,
  });
  const comTudo = metadataDoZeramento({ ...base, pulado: "listagem incompleta: x", falhas: ["a", "b", "c", "d", "e", "f"] }, null);
  assertEquals([comTudo.zeramento_pulado, comTudo.zeramento_falhas], ["listagem incompleta: x", ["a", "b", "c", "d", "e"]]);
  assertEquals(comTudo.zeramento_falhas_total, 6);
});

// ════════ adversarial do Codex (2026-10-05) ════════

Deno.test("aplicar — saldo com mais casas que um double ainda é zerado: o CAS é a versão, não o número", async () => {
  const tab = { inventory_position: [posicao("a", "vendas", 7, "11.720000000000000001", "2026-08-10T00:00:00+00:00")] };
  const { escritor } = fakeDb(tab);
  const r = await aplicarEscritaConfirmada(escritor, null, {
    posicoes: [{ account: "vendas", omie_codigo_produto: 7, casSyncedAt: "2026-08-10T00:00:00+00:00", set: { saldo: 0 } }],
    estoque: [],
  });
  assertEquals([r.posicoesZeradas, r.recusadosCas], [1, 0]);
});

Deno.test("orquestrador — o dono de vendas zera também o espelho oben (mesma conta Omie), cada um com seu CAS", async () => {
  const tab = {
    inventory_position: [
      posicao("a", "vendas", 7, 4, "2026-10-01T10:00:00Z"),
      posicao("b", "oben", 7, 4, "2026-10-05T12:30:00Z"),
      posicao("c", "colacor_vendas", 7, 4, "2026-10-05T12:30:00Z"), // outra conta Omie: intocada
    ],
    omie_products: [],
  };
  const { leitor, escritor } = fakeDb(tab);
  const r = await zerarConfirmadosForaDaLista({
    leitor,
    escritor,
    chamarOmie: () => Promise.resolve({ produtos: [{ nCodProd: 7, nSaldo: 0 }] }),
    account: "vendas",
    empresa: "oben",
    listados: new Set([1]),
    completude: { completa: true },
    dataPosicao: "05/10/2026",
    nowIso: NOW,
  });
  assertEquals(tab.inventory_position.map((l) => l.saldo), [0, 0, 4]);
  assertEquals(r.posicoesZeradas, 2);
});

function paginas(porPagina: Record<number, unknown[] | Error>) {
  const pedidas: number[] = [];
  const chamar = (p: Record<string, unknown>) => {
    const n = Number(p.nPagina);
    pedidas.push(n);
    const pg = porPagina[n];
    if (pg instanceof Error) return Promise.reject(pg);
    return Promise.resolve({ nTotPaginas: Object.keys(porPagina).length, produtos: pg ?? [] });
  };
  return { chamar, pedidas };
}

function cenarioPaginado() {
  // 34 tem 3 locais [0, 4, 0]: a 1ª entrada cai no fim da página 1 (cheia) e a positiva na página 2.
  const cods = Array.from({ length: 33 }, (_, i) => 1 + i);
  const pagina1: unknown[] = [];
  for (const c of cods) for (let k = 0; k < 3; k++) pagina1.push({ nCodProd: c, nSaldo: 0 });
  pagina1.push({ nCodProd: 34, nSaldo: 0 });
  const pagina2 = [{ nCodProd: 34, nSaldo: 4 }, { nCodProd: 34, nSaldo: 0 }];
  const inventory_position = [...cods, 34].map((c) => posicao(`p${c}`, "colacor_vendas", c, 1, null));
  return { pagina1, pagina2, inventory_position };
}

Deno.test("orquestrador — a confirmação PAGINA: entrada positiva na página 2 impede o zero", async () => {
  const { pagina1, pagina2, inventory_position } = cenarioPaginado();
  const tab = { inventory_position, omie_products: [] };
  const { leitor, escritor } = fakeDb(tab);
  const { chamar, pedidas } = paginas({ 1: pagina1, 2: pagina2 });
  const r = await zerarConfirmadosForaDaLista({
    leitor, escritor, chamarOmie: chamar, account: "colacor_vendas", empresa: null,
    listados: new Set([999]), completude: { completa: true }, dataPosicao: "05/10/2026", nowIso: NOW,
  });
  assertEquals(pagina1.length, 100);
  assertEquals(pedidas, [1, 2]);
  assertEquals(tab.inventory_position.find((l) => l.omie_codigo_produto === 34)?.saldo, 1);
  assertEquals([r.confirmadosZero, r.naoZero], [33, 1]);
});

Deno.test("orquestrador — página da confirmação que FALHA deixa o lote inteiro desconhecido (nada zerado)", async () => {
  const { pagina1, inventory_position } = cenarioPaginado();
  const tab = { inventory_position, omie_products: [] };
  const { leitor, escritor } = fakeDb(tab);
  const { chamar } = paginas({ 1: pagina1, 2: new Error("Omie: timeout") });
  const r = await zerarConfirmadosForaDaLista({
    leitor, escritor, chamarOmie: chamar, account: "colacor_vendas", empresa: null,
    listados: new Set([999]), completude: { completa: true }, dataPosicao: "05/10/2026", nowIso: NOW,
  });
  assertEquals([r.confirmadosZero, r.desconhecidos, r.posicoesZeradas], [0, 34, 0]);
  assertEquals(r.falhas.length, 1);
});

Deno.test("metadata — rodada sem apuração (snapshot vazio) diz por quê, com candidatos null", () => {
  assertEquals(metadataDoZeramento(null, null, "snapshot de posição vazio"), {
    zeramento_candidatos: null,
    zeramento_pulado: "snapshot de posição vazio",
  });
});
