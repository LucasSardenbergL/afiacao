// Composição da NCG no snapshot (engine v2.5, Fase 5 da Visão do CEO).
//
// O que este teste prova:
//   1. pelo HANDLER (PostgREST falso): o snapshot gravado leva as 6 colunas `ncg_*` com os MESMOS
//      componentes que a resposta devolve em `ncg.aco`/`ncg.pco`, e eles fecham com a coluna `ncg`;
//   2. sem estoque: `ncg_estoque` é NULL (nunca 0) e as outras 5 continuam medidas — NCG PARCIAL;
//   3. o helper puro: fora de faixa (NaN, negativo, teto) ou composição que não fecha com o total → as
//      6 colunas NULL ("não medido"), nunca um número que não bate.
// Linha de base: os casos 1 e 2 ficam VERMELHOS no código de antes (o INSERT não nomeava `ncg_*`); o
// CONTROLE VERDE é "a coluna `ncg` (total) do snapshot = `ncg.valor` da resposta", que já valia.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/fin-cashflow-engine/
import { ENV_TESTE, igual, instalarHarness } from "../_shared/harness-handler_test.ts";
import { hojeSP, somarDias } from "../_shared/hoje-sp.ts";
import { colunasComposicaoNcg } from "./ncg-composicao.ts";

const h = instalarHarness();
// Import COMPUTADO (ver index_test.ts): o type-check do index.ts é do gate `edges:typecheck`.
await import(new URL("./index.ts", import.meta.url).href);
const handler = h.handler();

const HOJE = hojeSP();

// ── Fixture ───────────────────────────────────────────────────────────────────────────────────
const uuid = (n: number, tabela: number) =>
  `${((n * 2654435761) >>> 0).toString(16).padStart(8, "0")}-000${tabela}-4000-8000-${n.toString(16).padStart(12, "0")}`;
const cp = (n: number, venc: string, saldo: number, categoria: string) => ({
  id: uuid(n, 2), saldo, valor_documento: saldo, valor_pago: 0,
  data_emissao: somarDias(HOJE, -10), data_vencimento: venc, data_pagamento: null,
  status_titulo: "A VENCER", categoria_codigo: categoria,
});
const CPS = [
  cp(1, somarDias(HOJE, 10), 1234.56, "2.05.01"), // fornecedor
  cp(2, somarDias(HOJE, 12), 300, "3.99.01"),     // tributo a pagar
  cp(3, somarDias(HOJE, 5), 70000, "2.10.01"),    // folha no ERP na janela de 30 d (> recorrente)
  cp(4, somarDias(HOJE, 20), 450, "2.03.01"),     // adiantamento a fornecedor (ACO, segregado pela config)
];
const CRS = Array.from({ length: 30 }, (_, i) => ({
  id: uuid(i, 1), saldo: 3000 + i, valor_documento: 3000 + i, valor_recebido: 0,
  data_emissao: somarDias(HOJE, -30), data_vencimento: somarDias(HOJE, 5 + i * 3), data_recebimento: null,
  status_titulo: "A VENCER", omie_codigo_cliente: 7000 + (i % 5), omie_codigo_lancamento: 500000 + i,
  nome_cliente: `Cliente ${i % 5}`, categoria_codigo: "1.01.01",
}));
const [anoH, mesH] = HOJE.split("-").map(Number);
const TABELAS: Record<string, unknown> = {
  fin_contas_correntes: [{ saldo_atual: 150000.25, saldo_data: HOJE }],
  fin_eventos_recorrentes: [
    { id: "rec-folha", descricao: "Folha", valor: 60000, tipo: "saida", categoria_dre: "pessoal", is_folha: true, dia_do_mes: 5, inicio: "2025-01-01", fim: null },
  ],
  fin_eventos_eventuais: [],
  fin_estoque_valor: [],
  fin_dre_snapshots: Array.from({ length: 15 }, (_, k) => {
    const idx = anoH * 12 + (mesH - 1) - 1 - k;
    return { cmv: 200000, ano: Math.floor(idx / 12), mes: (idx % 12) + 1 };
  }),
};
const CONFIG = {
  overrides_cenario: {},
  thresholds: {
    caixa_negativo_semanas: 13, ncg_deficit_alerta: 0, dias_cobertura_min: 30,
    inadimplencia_max_pct: 5, concentracao_top1_max_pct: 20, pmr_crescimento_max_pct_90d: 10,
  },
  adiantamento_categorias_codigos: ["2.03.01"],
};
const ESTOQUE_GIRO = { valor_giro: 500000, skus_giro: 900, cobertura_pct: 97, valor_sem_classificacao: 0 };
const RPCS: Record<string, unknown> = {
  fin_titulo_baixas_cr_mapa: { total: 0, pares: [] },
  fin_capital_giro_prazos_empresa: { existe: true, pmr: 40, pmp: 30, pmr_cobertura: 0.8, pmp_cobertura: 0.7 },
  fin_estoque_giro_valor: ESTOQUE_GIRO,
};

// ── PostgREST falso ───────────────────────────────────────────────────────────────────────────
const snapshots: Array<Record<string, unknown>> = [];
const json = (corpo: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json", ...extra } });

function paginar(linhas: Array<Record<string, unknown>>, url: URL): Response {
  let sel = [...linhas];
  for (const f of url.searchParams.getAll("id")) {
    const [op, v] = [f.slice(0, f.indexOf(".")), f.slice(f.indexOf(".") + 1)];
    sel = sel.filter((l) => {
      const id = l.id as string;
      return op === "gte" ? id >= v : op === "lt" ? id < v : op === "gt" ? id > v : true;
    });
  }
  sel.sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1));
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
    if (caminho === "fin_alertas") return json([]);
    if (caminho in TABELAS) return json(TABELAS[caminho]);
  }
  if (req.method === "POST" && caminho.startsWith("rpc/")) {
    const fn = caminho.slice(4);
    if (fn in RPCS) return json(RPCS[fn]);
  }
  const corpo = req.method === "GET" ? null : await req.text().then((t) => (t ? JSON.parse(t) : null));
  if (req.method === "POST" && caminho === "acoes_execucoes") return json({ id: "reg-1" }, 201);
  if (req.method === "POST" && caminho === "fin_projecao_snapshots") {
    snapshots.push(corpo as Record<string, unknown>);
    return new Response(null, { status: 201 });
  }
  if ((req.method === "POST" || req.method === "PATCH") && (caminho === "fin_alertas" || caminho === "acoes_execucoes")) {
    return new Response(null, { status: req.method === "POST" ? 201 : 204 });
  }
  throw new Error(`PostgREST falso: rota não prevista ${req.method} ${url.pathname}${url.search}`);
});

const URL_EDGE = `${ENV_TESTE.SUPABASE_URL}/functions/v1/fin-cashflow-engine`;
async function rodar(estoqueGiro: unknown) {
  RPCS.fin_estoque_giro_valor = estoqueGiro;
  snapshots.length = 0;
  h.limpar();
  const res = await handler(new Request(URL_EDGE, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": ENV_TESTE.CRON_SECRET },
    body: JSON.stringify({ company: "oben", cenario: "realista", save_snapshot: true }),
  }));
  const corpo = await res.json() as Record<string, unknown>;
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(corpo)}`);
  if (snapshots.length !== 1) throw new Error(`esperava 1 snapshot gravado, veio ${snapshots.length}`);
  return { corpo, snapshot: snapshots[0] };
}

const COMPLETA = await rodar(ESTOQUE_GIRO);
const PARCIAL = await rodar(null);

type NcgResposta = {
  aco: { cr_aberto: number; estoque: number | null; adiantamentos: number };
  pco: { cp_fornecedor: number; folha_30d: number; tributos_a_pagar: number };
  valor: number; parcial: boolean;
};
const ncgDe = (r: typeof COMPLETA) => r.corpo.ncg as NcgResposta;
const composicao = (s: Record<string, unknown>) => ({
  cr_aberto: s.ncg_cr_aberto, estoque: s.ncg_estoque, adiantamentos: s.ncg_adiantamentos,
  cp_fornecedor: s.ncg_cp_fornecedor, folha_30d: s.ncg_folha_30d, tributos_a_pagar: s.ncg_tributos_a_pagar,
});

Deno.test("controle: a coluna ncg (total) do snapshot = ncg.valor da resposta", () => {
  igual(COMPLETA.snapshot.ncg, ncgDe(COMPLETA).valor, "ncg do snapshot (completa)");
  igual(PARCIAL.snapshot.ncg, ncgDe(PARCIAL).valor, "ncg do snapshot (parcial)");
});

Deno.test("fixture: a NCG completa tem estoque e a parcial não", () => {
  igual(ncgDe(COMPLETA).parcial, false, "FIXTURE_FRACA: NCG completa saiu parcial");
  igual(ncgDe(PARCIAL).parcial, true, "FIXTURE_FRACA: NCG sem estoque saiu completa");
});

Deno.test("snapshot completo: as 6 colunas ncg_* casam EXATO e fecham com o total", () => {
  igual(
    composicao(COMPLETA.snapshot),
    { cr_aberto: 90435, estoque: 500000, adiantamentos: 450, cp_fornecedor: 1234.56, folha_30d: 70000, tributos_a_pagar: 300 },
    "colunas ncg_* (completa)",
  );
  const n = ncgDe(COMPLETA);
  igual(composicao(COMPLETA.snapshot), { ...n.aco, ...n.pco, total: undefined }, "colunas ≠ resposta ncg.aco/ncg.pco");
  igual(Math.round((COMPLETA.snapshot.ncg as number) * 100), Math.round((90435 + 500000 + 450 - 1234.56 - 70000 - 300) * 100), "NCG total");
});

Deno.test("snapshot sem estoque: ncg_estoque NULL (nunca 0), as outras 5 medidas — parcial", () => {
  igual(
    composicao(PARCIAL.snapshot),
    { cr_aberto: 90435, estoque: null, adiantamentos: 450, cp_fornecedor: 1234.56, folha_30d: 70000, tributos_a_pagar: 300 },
    "colunas ncg_* (parcial)",
  );
});

// ── Helper puro ───────────────────────────────────────────────────────────────────────────────
const BASE = {
  aco: { cr_aberto: 100, estoque: 50 as number | null, adiantamentos: 10 },
  pco: { cp_fornecedor: 40, folha_30d: 20, tributos_a_pagar: 5 },
  valor: 95,
};
const NULAS = {
  ncg_cr_aberto: null, ncg_estoque: null, ncg_adiantamentos: null,
  ncg_cp_fornecedor: null, ncg_folha_30d: null, ncg_tributos_a_pagar: null,
};

Deno.test("helper: composição coerente passa em centavos", () => {
  igual(
    colunasComposicaoNcg({ ...BASE, aco: { ...BASE.aco, cr_aberto: 100.004 }, valor: 95.004 }, true),
    { ncg_cr_aberto: 100, ncg_estoque: 50, ncg_adiantamentos: 10, ncg_cp_fornecedor: 40, ncg_folha_30d: 20, ncg_tributos_a_pagar: 5 },
    "coerente",
  );
});

Deno.test("helper: fora de faixa ou que não fecha → as 6 NULL (não medido)", () => {
  const casos: Array<[string, typeof BASE]> = [
    ["NaN", { ...BASE, aco: { ...BASE.aco, cr_aberto: NaN } }],
    ["negativo", { ...BASE, pco: { ...BASE.pco, folha_30d: -1 } }],
    ["teto", { ...BASE, aco: { ...BASE.aco, cr_aberto: 2e10 }, valor: 2e10 - 5 }],
    ["estoque NaN", { ...BASE, aco: { ...BASE.aco, estoque: NaN } }],
    ["total infinito", { ...BASE, valor: Infinity }],
    ["não fecha", { ...BASE, valor: 96 }],
    // Achado Codex P1: passa na faixa ANTES de arredondar, vira 1e10 depois — o CHECK (< 1e10) recusaria.
    ["teto após arredondar", {
      aco: { cr_aberto: 0, estoque: 9999999999.999, adiantamentos: 0 },
      pco: { cp_fornecedor: 0, folha_30d: 0, tributos_a_pagar: 0 }, valor: 9999999999.999,
    }],
    // Achado Codex P2: na fronteira o float aceita 0,05 e o numeric do banco não; o helper recusa antes.
    ["fronteira do fechamento", {
      aco: { cr_aberto: 0.1, estoque: 0.2, adiantamentos: 0 },
      pco: { cp_fornecedor: 0, folha_30d: 0, tributos_a_pagar: 0 }, valor: 0.35000000000000003,
    }],
  ];
  for (const [nome, entrada] of casos) igual(colunasComposicaoNcg(entrada, true), NULAS, `caso ${nome}`);
});

Deno.test("helper: sem categoria de adiantamento configurada → ncg_adiantamentos NULL (não segregado), resto medido", () => {
  igual(
    colunasComposicaoNcg({ ...BASE, aco: { ...BASE.aco, adiantamentos: 0 }, valor: 85 }, false),
    { ncg_cr_aberto: 100, ncg_estoque: 50, ncg_adiantamentos: null, ncg_cp_fornecedor: 40, ncg_folha_30d: 20, ncg_tributos_a_pagar: 5 },
    "não segregado",
  );
});
