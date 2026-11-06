// D10 do plano v7 — PARIDADE e CARGA ÚNICA do caminho `cenarios: [...]` da fin-cashflow-engine.
//
// Money-path: o cron passa de 3 chamadas por empresa (uma por cenário, cada uma com a sua carga) para
// UMA chamada com `cenarios`, que carrega os dados uma vez. O que este teste prova, pelo HANDLER e com
// o MESMO input (um PostgREST falso servindo a mesma fixture a todas as leituras):
//   1. paridade — snapshot gravado, resposta e escritas de alerta de cada cenário são IDÊNTICOS aos
//      das 3 chamadas de cenário único (o caminho de antes, que segue existindo);
//   2. carga única — cada leitura da carga sai UMA vez na chamada multi, contra 3 nas 3 chamadas;
//   3. isolamento — um cenário cujo INSERT falha não leva os outros, e a resposta é 500 com o detalhe;
//      a carga que falha falha os três (um registro de erro por cenário), sem gravar nada e sem reler;
//   4. validação — `cenarios` inválido é 400 SEM nenhuma leitura ou escrita.
// A fixture exercita as curvas calibradas (deltas de cenário mudam o número), folha, adiantamento,
// tributo, eventos e alertas — sem isso a paridade passaria por um cálculo que não depende de nada.
//
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/fin-cashflow-engine/
import { ENV_TESTE, igual, instalarHarness } from "../_shared/harness-handler_test.ts";
import { hojeSP, somarDias } from "../_shared/hoje-sp.ts";

const h = instalarHarness();
// Import COMPUTADO (ver index_test.ts): o type-check do index.ts é do gate `edges:typecheck`.
await import(new URL("./index.ts", import.meta.url).href);
const handler = h.handler();

// ── Fixture determinística ────────────────────────────────────────────────────────────────────
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// uuid espalhado pelas 8 faixas do `fetchAllParticionadoUuid` (o 1º dígito varia).
const uuid = (n: number, tabela: number) =>
  `${((n * 2654435761) >>> 0).toString(16).padStart(8, "0")}-000${tabela}-4000-8000-${n.toString(16).padStart(12, "0")}`;

const HOJE = hojeSP();
const r = prng(20261105);
const centavos = (min: number, max: number) => Math.round((min + r() * (max - min)) * 100) / 100;
const CLIENTES = ["Moveis Alfa", "Marcenaria Beta", "Gama Esquadrias", "Delta Pisos", "Epsilon", "Zeta", "Eta", "Teta"];

const CRS: Array<Record<string, unknown>> = [];
const BAIXAS: Array<[number, string]> = [];
for (let i = 0; i < 700; i++) {
  const cod = 500000 + i;
  const cliente = i % 5 === 0 ? CLIENTES[0] : CLIENTES[i % CLIENTES.length];
  const valor = centavos(800, 9000);
  if (i < 450) {
    // liquidado: vencimento no último ano, baixa com atraso variado (todas as faixas de aging)
    const venc = somarDias(HOJE, -Math.floor(20 + r() * 330));
    const atraso = [0, 0, 3, 12, 25, 45, 75, 130][i % 8] + Math.floor(r() * 5);
    if (i % 9 !== 0) BAIXAS.push([cod, somarDias(venc, atraso)]); // ~89% com baixa derivada
    CRS.push({
      id: uuid(i, 1), saldo: valor, valor_documento: valor, valor_recebido: 0,
      data_emissao: somarDias(venc, -30), data_vencimento: venc, data_recebimento: null,
      status_titulo: "RECEBIDO", omie_codigo_cliente: 7000 + (i % 8), omie_codigo_lancamento: cod,
      nome_cliente: cliente, categoria_codigo: "1.01.01",
    });
  } else {
    // aberto: a vencer (até 120 d) e atrasado (até 200 d)
    const aVencer = i % 3 !== 0;
    const venc = aVencer ? somarDias(HOJE, Math.floor(1 + r() * 120)) : somarDias(HOJE, -Math.floor(1 + r() * 200));
    CRS.push({
      id: uuid(i, 1), saldo: valor, valor_documento: valor, valor_recebido: 0,
      data_emissao: somarDias(venc, -30), data_vencimento: venc, data_recebimento: null,
      status_titulo: aVencer ? "A VENCER" : "ATRASADO", omie_codigo_cliente: 7000 + (i % 8),
      omie_codigo_lancamento: cod, nome_cliente: cliente, categoria_codigo: "1.01.01",
    });
  }
}
const CATS_CP = ["2.05.01", "2.10.01", "2.01.98", "3.99.01", "2.07.03"];
const CPS: Array<Record<string, unknown>> = [];
for (let i = 0; i < 260; i++) {
  const valor = centavos(1500, 30000);
  const pago = i % 7 === 0;
  CPS.push({
    id: uuid(i, 2), saldo: valor, valor_documento: valor, valor_pago: 0,
    data_emissao: somarDias(HOJE, -20), data_vencimento: somarDias(HOJE, Math.floor(-10 + r() * 100)),
    data_pagamento: null, status_titulo: pago ? "PAGO" : "A VENCER", categoria_codigo: CATS_CP[i % CATS_CP.length],
  });
}
const [anoH, mesH] = HOJE.split("-").map(Number);
const DRE = Array.from({ length: 15 }, (_, k) => {
  const idx = anoH * 12 + (mesH - 1) - 1 - k;
  return { cmv: 410000 + k * 1000, ano: Math.floor(idx / 12), mes: (idx % 12) + 1 };
});

const TABELAS: Record<string, unknown> = {
  fin_contas_correntes: [
    { saldo_atual: 280000.55, saldo_data: new Date().toISOString() },
    { saldo_atual: 41000.1, saldo_data: new Date().toISOString() },
  ],
  fin_eventos_recorrentes: [
    { id: "rec-folha", descricao: "Folha", valor: 160000, tipo: "saida", categoria_dre: "pessoal", is_folha: true, dia_do_mes: 5, inicio: "2025-01-01", fim: null },
    { id: "rec-aluguel", descricao: "Aluguel", valor: 18000, tipo: "saida", categoria_dre: "ocupacao", is_folha: false, dia_do_mes: 10, inicio: "2025-01-01", fim: null },
    { id: "rec-locacao", descricao: "Locação recebida", valor: 4000, tipo: "entrada", categoria_dre: "outras", is_folha: false, dia_do_mes: 15, inicio: "2025-01-01", fim: null },
  ],
  fin_eventos_eventuais: [
    { id: "ev-1", descricao: "Aporte", valor: 50000, tipo: "entrada", categoria_dre: null, data_prevista: somarDias(HOJE, 9), status: "confirmado" },
    { id: "ev-2", descricao: "Máquina", valor: 90000, tipo: "saida", categoria_dre: null, data_prevista: somarDias(HOJE, 23), status: "previsto" },
  ],
  fin_estoque_valor: [],
  fin_dre_snapshots: DRE,
  fin_alertas: [],
};
const CONFIG = {
  overrides_cenario: {
    otimista: { recebimento_no_prazo_pct_delta: 20, inadimplencia_pct_delta: -30 },
    pessimista: { recebimento_no_prazo_pct_delta: -25, inadimplencia_pct_delta: 50 },
  },
  thresholds: {
    caixa_negativo_semanas: 13, ncg_deficit_alerta: 0, dias_cobertura_min: 30,
    inadimplencia_max_pct: 5, concentracao_top1_max_pct: 20, pmr_crescimento_max_pct_90d: 10,
  },
  adiantamento_categorias_codigos: ["2.01.98"],
};
const RPCS: Record<string, unknown> = {
  fin_titulo_baixas_cr_mapa: { total: BAIXAS.length, pares: BAIXAS },
  fin_capital_giro_prazos_empresa: { existe: true, pmr: 41.7, pmp: 33.2, pmr_cobertura: 0.81, pmp_cobertura: 0.66 },
  fin_estoque_giro_valor: [{ valor_giro: 912345.67, skus_giro: 1311, cobertura_pct: 97.4, valor_sem_classificacao: 0 }],
};

// ── PostgREST falso ───────────────────────────────────────────────────────────────────────────
type Escrita = { metodo: string; tabela: string; corpo: unknown; query: string };
const escritas: Escrita[] = [];
let falharInsertSnapshotDe: string | null = null;
let falharBaixas = false;
let regSeq = 0;

const json = (corpo: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json", ...extra } });

/** Paginação por keyset em `id` (gte/lt/gt + limit), com o count exato no Content-Range. */
function paginar(linhas: Array<Record<string, unknown>>, url: URL): Response {
  let sel = linhas.filter((l) => l.status_titulo !== "CANCELADO");
  for (const f of url.searchParams.getAll("id")) {
    const [op, v] = [f.slice(0, f.indexOf(".")), f.slice(f.indexOf(".") + 1)];
    sel = sel.filter((l) => {
      const id = l.id as string;
      return op === "gte" ? id >= v : op === "lt" ? id < v : op === "gt" ? id > v : true;
    });
  }
  sel.sort((a, b) => (a.id as string) < (b.id as string) ? -1 : 1);
  const total = sel.length;
  const pagina = sel.slice(0, Number(url.searchParams.get("limit") ?? total));
  const range = pagina.length > 0 ? `0-${pagina.length - 1}/${total}` : `*/${total}`;
  return json(pagina, 200, { "content-range": range });
}

h.responderForaDoGate(async (req) => {
  const url = new URL(req.url);
  const caminho = url.pathname.replace("/rest/v1/", "");
  if (req.method === "GET") {
    if (caminho === "fin_contas_receber") return paginar(CRS, url);
    if (caminho === "fin_contas_pagar") return paginar(CPS, url);
    if (caminho === "fin_config_cashflow") {
      const sel = url.searchParams.get("select") ?? "";
      return json([sel.includes("folha_categorias_codigos") ? { folha_categorias_codigos: ["2.10.01"] } : CONFIG]);
    }
    if (caminho in TABELAS) return json(TABELAS[caminho]);
  }
  if (req.method === "POST" && caminho.startsWith("rpc/")) {
    const fn = caminho.slice(4);
    if (fn === "fin_titulo_baixas_cr_mapa" && falharBaixas) {
      return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
    }
    if (fn in RPCS) return json(RPCS[fn]);
  }
  const corpo = req.method === "GET" ? null : await req.text().then((t) => (t ? JSON.parse(t) : null));
  if (req.method === "POST" && caminho === "acoes_execucoes") {
    escritas.push({ metodo: "POST", tabela: caminho, corpo, query: url.search });
    return json({ id: `reg-${++regSeq}` }, 201);
  }
  if (req.method === "POST" && caminho === "fin_projecao_snapshots") {
    escritas.push({ metodo: "POST", tabela: caminho, corpo, query: url.search });
    if (falharInsertSnapshotDe && (corpo as { cenario: string }).cenario === falharInsertSnapshotDe) {
      return json({ code: "23514", message: "violates check constraint" }, 400);
    }
    return new Response(null, { status: 201 });
  }
  if ((req.method === "POST" || req.method === "PATCH") && (caminho === "fin_alertas" || caminho === "acoes_execucoes")) {
    escritas.push({ metodo: req.method, tabela: caminho, corpo, query: url.search });
    return new Response(null, { status: req.method === "POST" ? 201 : 204 });
  }
  throw new Error(`PostgREST falso: rota não prevista ${req.method} ${url.pathname}${url.search}`);
});

// ── Utilitários ───────────────────────────────────────────────────────────────────────────────
const URL_EDGE = `${ENV_TESTE.SUPABASE_URL}/functions/v1/fin-cashflow-engine`;
async function chamar(corpo: unknown): Promise<{ status: number; corpo: Record<string, unknown> }> {
  const res = await handler(new Request(URL_EDGE, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": ENV_TESTE.CRON_SECRET },
    body: JSON.stringify(corpo),
  }));
  return { status: res.status, corpo: await res.json() };
}
function zerar() {
  h.limpar();
  escritas.length = 0;
  regSeq = 0;
  falharInsertSnapshotDe = null;
  falharBaixas = false;
}
/** Leituras da carga por rota (GET de tabela e POST de RPC), sem as escritas. */
function leiturasPorRota(): Record<string, number> {
  const n: Record<string, number> = {};
  for (const req of h.chamadasForaDoGate()) {
    const caminho = new URL(req.url).pathname.replace("/rest/v1/", "");
    if (req.method !== "GET" && !caminho.startsWith("rpc/")) continue;
    n[caminho] = (n[caminho] ?? 0) + 1;
  }
  return n;
}
/** Tira o que é carimbo de relógio do próprio teste (dismissed_at, finalizado_em, iniciado_em). */
function semRelogio(e: Escrita): Escrita {
  const c = e.corpo && typeof e.corpo === "object" ? { ...(e.corpo as Record<string, unknown>) } : e.corpo;
  if (c && typeof c === "object") {
    for (const k of ["dismissed_at", "finalizado_em", "iniciado_em"]) {
      if (k in (c as Record<string, unknown>)) (c as Record<string, unknown>)[k] = "<relogio>";
    }
  }
  return { ...e, corpo: c, query: e.query.replace(/reg-\d+/, "reg-N") };
}
const snapshotsPorCenario = (es: Escrita[]) =>
  Object.fromEntries(
    es.filter((e) => e.tabela === "fin_projecao_snapshots").map((e) => [(e.corpo as { cenario: string }).cenario, e.corpo]),
  );
const doCenario = (cen: string) => ({ company: "colacor", cenario: cen, save_snapshot: true });
const CENARIOS = ["realista", "otimista", "pessimista"];

// ── Linha de base: as 3 chamadas de cenário único (o caminho de antes) ─────────────────────────
zerar();
const base: Record<string, Record<string, unknown>> = {};
const baseLeituras: Record<string, number> = {};
const baseEscritas: Escrita[] = [];
for (const cen of CENARIOS) {
  const res = await chamar(doCenario(cen));
  if (res.status !== 200) throw new Error(`linha de base ${cen}: HTTP ${res.status} ${JSON.stringify(res.corpo)}`);
  base[cen] = res.corpo;
}
Object.assign(baseLeituras, leiturasPorRota());
baseEscritas.push(...escritas);

Deno.test("fixture: os 3 cenários de cenário único divergem entre si (a paridade abaixo não é trivial)", () => {
  const ncgSemana = (cen: string) => JSON.stringify((base[cen].semanas as unknown[]).map((s) => (s as { saldo_final: number }).saldo_final));
  if (ncgSemana("realista") === ncgSemana("otimista") || ncgSemana("realista") === ncgSemana("pessimista")) {
    throw new Error("FIXTURE_FRACA: as semanas não dependem do cenário — a paridade não provaria nada");
  }
  const alertas = (base.realista.alertas as unknown[]).length;
  if (alertas === 0) throw new Error("FIXTURE_FRACA: nenhum alerta no realista — o ramo de fin_alertas não roda");
  const curvasAlta = Object.values(base.realista.curvas_aging as Record<string, { confianca: string }>)
    .filter((c) => c.confianca === "alta").length;
  if (curvasAlta === 0) throw new Error("FIXTURE_FRACA: nenhuma curva calibrada — o mapa de baixas não pesa no número");
});

Deno.test("cenarios: UMA chamada = mesmos snapshots, respostas e alertas das 3 chamadas de cenário único", async () => {
  zerar();
  const res = await chamar({ company: "colacor", cenarios: CENARIOS, save_snapshot: true });
  igual(res.status, 200, "status da chamada multi");
  const resultados = res.corpo.resultados as Array<Record<string, unknown>>;
  igual(resultados.map((x) => x.cenario), CENARIOS, "ordem dos cenários na resposta");
  for (const x of resultados) {
    const { cenario, ...resto } = x;
    const { versao: _v, ...esperado } = base[cenario as string];
    igual(resto, esperado, `resposta do cenário ${cenario as string}`);
  }
  igual(snapshotsPorCenario(escritas), snapshotsPorCenario(baseEscritas), "snapshot gravado por cenário");
  // Sequência COMPLETA de escritas (registro, snapshot, alertas) — mesma ordem das 3 chamadas em série.
  igual(escritas.map(semRelogio), baseEscritas.map(semRelogio), "sequência de escritas");
});

Deno.test("cenarios: a carga sai UMA vez (cada leitura 1×), contra 3× nas 3 chamadas", async () => {
  zerar();
  const res = await chamar({ company: "colacor", cenarios: CENARIOS, save_snapshot: true });
  igual(res.status, 200, "status da chamada multi");
  const multi = leiturasPorRota();
  igual(Object.keys(multi).sort(), Object.keys(baseLeituras).sort(), "mesmas fontes lidas");
  for (const [rota, n] of Object.entries(baseLeituras)) {
    // fin_alertas é lido no cenário realista (decidir UPDATE vs INSERT), não na carga.
    const esperado = rota === "fin_alertas" ? n : n / 3;
    igual(multi[rota], esperado, `leituras de ${rota}`);
  }
  igual(multi["rpc/fin_titulo_baixas_cr_mapa"], 1, "mapa de baixas lido uma vez");
});

Deno.test("cenarios: INSERT recusado num cenário não leva os outros — 500 com o detalhe", async () => {
  zerar();
  falharInsertSnapshotDe = "otimista";
  const res = await chamar({ company: "colacor", cenarios: CENARIOS, save_snapshot: true });
  igual(res.status, 500, "status com um cenário falho");
  igual((res.corpo.falhas as Array<{ cenario: string }>).map((f) => f.cenario), ["otimista"], "cenário falho");
  igual(res.corpo.cenarios_ok, ["realista", "pessimista"], "cenários gravados");
  igual(escritas.filter((e) => e.tabela === "fin_projecao_snapshots").length, 3, "3 tentativas de INSERT, nenhuma repetida");
  const fechamentos = escritas.filter((e) => e.tabela === "acoes_execucoes" && e.metodo === "PATCH")
    .map((e) => (e.corpo as { status: string }).status);
  igual(fechamentos, ["sucesso", "erro", "sucesso"], "um registro por cenário, com o desfecho de cada um");
});

Deno.test("cenarios: carga que falha falha os 3, sem gravar snapshot e sem reler", async () => {
  zerar();
  falharBaixas = true;
  const res = await chamar({ company: "colacor", cenarios: CENARIOS, save_snapshot: true });
  igual(res.status, 500, "status com a carga falha");
  igual((res.corpo.falhas as Array<{ cenario: string }>).map((f) => f.cenario), CENARIOS, "os 3 falham");
  igual(escritas.filter((e) => e.tabela === "fin_projecao_snapshots").length, 0, "nenhum snapshot");
  igual(leiturasPorRota()["rpc/fin_titulo_baixas_cr_mapa"], 1, "a carga falha não é repetida por cenário");
  const fechamentos = escritas.filter((e) => e.tabela === "acoes_execucoes" && e.metodo === "PATCH")
    .map((e) => (e.corpo as { status: string }).status);
  igual(fechamentos, ["erro", "erro", "erro"], "um registro de erro por cenário");
});

Deno.test("cenarios: sem save_snapshot não escreve nada", async () => {
  zerar();
  const res = await chamar({ company: "colacor", cenarios: ["pessimista", "realista"] });
  igual(res.status, 200, "status sem save");
  igual((res.corpo.resultados as Array<{ cenario: string }>).map((x) => x.cenario), ["pessimista", "realista"], "cenários pedidos");
  igual(escritas.length, 0, "zero escritas");
});

for (
  const [nome, corpo, erro] of [
    ["vazio", { company: "colacor", cenarios: [] }, "cenarios: lista não vazia"],
    ["não-lista", { company: "colacor", cenarios: "realista" }, "cenarios: lista não vazia"],
    ["desconhecido", { company: "colacor", cenarios: ["realista", "neutro"] }, "cenarios: valor inválido"],
    ["repetido", { company: "colacor", cenarios: ["realista", "realista"] }, "cenarios: valor repetido"],
    ["com cenario junto", { company: "colacor", cenario: "realista", cenarios: ["otimista"] }, "use cenario OU cenarios, não os dois"],
  ] as const
) {
  Deno.test(`cenarios ${nome} → 400 sem nenhuma leitura ou escrita`, async () => {
    zerar();
    const res = await chamar({ ...corpo, save_snapshot: true });
    igual(res.status, 400, "status");
    igual(res.corpo.error, erro, "mensagem");
    igual(h.chamadasForaDoGate().length, 0, "requests fora do gate");
  });
}
