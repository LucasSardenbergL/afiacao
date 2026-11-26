// Composição da NCG no snapshot (engine v2.5, Fase 5 da Visão do CEO).
//
// O que este teste prova:
//   1. pelo HANDLER (PostgREST falso): o snapshot gravado leva as 6 colunas `ncg_*` com os MESMOS
//      componentes que a resposta devolve em `ncg.aco`/`ncg.pco`, e eles fecham com a coluna `ncg`;
//   2. sem estoque: `ncg_estoque` é NULL (nunca 0) e as outras 5 continuam medidas — NCG PARCIAL;
//   3. o helper puro: fora de faixa (NaN, negativo, teto) ou composição que não fecha com o total → as
//      6 colunas NULL ("não medido"), nunca um número que não bate.
//   4. (v2.7) folha/tributos pelo mapa por empresa + código: os títulos saem de cp_fornecedor sem mudar o
//      total; folha só na janela [hoje−30, hoje+30]; colacor_sc sem fonte = não medido, oben = zero medido;
//      mapa ilegível LANÇA. Falsificado em 26/11 (10 sabotagens, uma camada por vez, controle verde antes e
//      depois na mesma invocação — ver docs/historico/ncg-folha-tributos-fonte-vazia.md).
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
// Plano real do grupo (sintético nos valores): folha em 2.03 (op_pessoal), tributos em 2.06 (op_impostos /
// op_impostos_lucro), parcelamento em linha própria (fica em cp_fornecedor), adiantamento segregado pela config.
const CPS_PADRAO = [
  cp(1, somarDias(HOJE, 10), 1234.56, "2.05.01"), // fornecedor (sem mapa de folha/tributo)
  cp(2, somarDias(HOJE, 12), 300, "2.06.99"),     // tributo a pagar (op_impostos)
  cp(3, somarDias(HOJE, -60), 200, "2.06.05"),    // IRPJ vencido: tributo sem janela (op_impostos_lucro)
  cp(4, somarDias(HOJE, 40), 800, "2.06.50"),     // parcelamento: passivo financeiro → cp_fornecedor
  cp(5, somarDias(HOJE, 5), 70000, "2.03.01"),    // folha a vencer na janela
  cp(6, somarDias(HOJE, -20), 5000, "2.03.07"),   // folha atrasada 20 d: entra (limite 30 d)
  cp(7, somarDias(HOJE, -45), 4000, "2.03.01"),   // folha atrasada 45 d: fora → cp_fornecedor + motivo
  cp(8, somarDias(HOJE, 40), 3000, "2.03.98"),    // folha depois da janela → cp_fornecedor
  cp(9, somarDias(HOJE, 20), 450, "2.01.98"),     // adiantamento a fornecedor (ACO, segregado pela config)
];
let CPS: Array<ReturnType<typeof cp>> = CPS_PADRAO;
const MAPA_PADRAO = [
  { omie_codigo: "2.03.01", fluxo_linha: "op_pessoal" },
  { omie_codigo: "2.03.07", fluxo_linha: "op_pessoal" },
  { omie_codigo: "2.03.98", fluxo_linha: "op_pessoal" },
  { omie_codigo: "2.06.99", fluxo_linha: "op_impostos" },
  { omie_codigo: "2.06.05", fluxo_linha: "op_impostos_lucro" },
  // Linhas que a NCG não usa, mas que provam o código MAPEADO (ausência = mapa incompleto).
  { omie_codigo: "2.06.50", fluxo_linha: "op_impostos_parcelamento" },
  { omie_codigo: "2.05.01", fluxo_linha: "op_fornecedores" },
];
// Mapa POR EMPRESA: o falso só devolve a linha da empresa pedida em `company=eq.` (prova o filtro).
let MAPAS: Record<string, unknown> = {};
let MAPA_FALHA: "nao" | "timeout" | "corpo-nulo" = "nao";
const EVENTOS_PADRAO = [
  { id: "rec-folha", descricao: "Folha", valor: 60000, tipo: "saida", categoria_dre: "pessoal", is_folha: true, dia_do_mes: 5, inicio: "2025-01-01", fim: null },
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
  fin_eventos_recorrentes: EVENTOS_PADRAO,
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
  adiantamento_categorias_codigos: ["2.01.98"],
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
    if (caminho === "fin_config_cashflow") return json([CONFIG]);
    if (caminho === "fin_categoria_fluxo_mapping") {
      if (MAPA_FALHA === "timeout") return json({ code: "57014", message: "canceling statement due to statement timeout" }, 500);
      if (MAPA_FALHA === "corpo-nulo") return json(null);
      const empresa = (url.searchParams.get("company") ?? "").replace(/^eq\./, "");
      const linhas = (MAPAS[empresa] ?? []) as unknown[];
      return json(linhas.slice(0, Number(url.searchParams.get("limit") ?? linhas.length)));
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
type Cenario = { cps?: typeof CPS; mapa?: unknown; mapas?: Record<string, unknown>; eventos?: unknown[]; company?: string };
async function chamar(estoqueGiro: unknown, cen: Cenario = {}) {
  RPCS.fin_estoque_giro_valor = estoqueGiro;
  CPS = cen.cps ?? CPS_PADRAO;
  const empresa = cen.company ?? "colacor_sc";
  MAPAS = cen.mapas ?? { [empresa]: cen.mapa ?? MAPA_PADRAO };
  TABELAS.fin_eventos_recorrentes = cen.eventos ?? EVENTOS_PADRAO;
  snapshots.length = 0;
  h.limpar();
  const res = await handler(new Request(URL_EDGE, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": ENV_TESTE.CRON_SECRET },
    body: JSON.stringify({ company: empresa, cenario: "realista", save_snapshot: true }),
  }));
  return { res, corpo: await res.json() as Record<string, unknown> };
}
async function rodar(estoqueGiro: unknown, cen: Cenario = {}) {
  const { res, corpo } = await chamar(estoqueGiro, cen);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(corpo)}`);
  if (snapshots.length !== 1) throw new Error(`esperava 1 snapshot gravado, veio ${snapshots.length}`);
  return { corpo, snapshot: snapshots[0] };
}

const ehFolha = (c: ReturnType<typeof cp>) => c.categoria_codigo.startsWith("2.03.");
const ehTributo = (c: ReturnType<typeof cp>) => c.categoria_codigo === "2.06.99" || c.categoria_codigo === "2.06.05";

// colacor_sc = a empresa da folha do grupo (fonte vazia de folha = não medido).
const COMPLETA = await rodar(ESTOQUE_GIRO);
const PARCIAL = await rodar(null);
// Estado de prod até a v2.6: nada no mapa (ou o mapa não lido) → tudo em cp_fornecedor, composição não medida.
const MAPA_VAZIO = await rodar(ESTOQUE_GIRO, { mapa: [], eventos: [] });
// Tributo que o mapa classifica, mas só PAGO (com e sem saldo residual): histórico não atesta (achado Codex v2.6).
const TRIBUTO_SO_PAGO = await rodar(ESTOQUE_GIRO, {
  cps: CPS_PADRAO.map((c) => ehTributo(c) ? { ...c, status_titulo: "PAGO", saldo: 0 } : c),
});
const TRIBUTO_PAGO_RESIDUAL = await rodar(ESTOQUE_GIRO, {
  cps: CPS_PADRAO.map((c) => ehTributo(c) ? { ...c, status_titulo: "PAGO" } : c),
});
// Folha medida por UMA fonte só (prova o `||`): só o recorrente / só os CPs da janela.
const SO_RECORRENTE = await rodar(ESTOQUE_GIRO, { cps: CPS_PADRAO.filter((c) => !ehFolha(c)) });
const SO_CP_FOLHA = await rodar(ESTOQUE_GIRO, { eventos: [] });
// colacor_sc sem título de folha na janela e sem recorrente VIGENTE (o único acabou ontem): fonte vazia.
const SO_FORA_DA_JANELA = CPS_PADRAO.filter((c) => !ehFolha(c) || c.id === CPS_PADRAO[6].id || c.id === CPS_PADRAO[7].id);
const RECORRENTE_ENCERRADO = [{ ...EVENTOS_PADRAO[0], fim: somarDias(HOJE, -1) }];
const SEM_FOLHA_SC = await rodar(ESTOQUE_GIRO, { cps: SO_FORA_DA_JANELA, eventos: RECORRENTE_ENCERRADO });
// Folha centralizada: na oben, sem título na janela nem recorrente, folha é ZERO MEDIDO (mapa com pessoal)…
const SEM_FOLHA_OBEN = await rodar(ESTOQUE_GIRO, { company: "oben", cps: SO_FORA_DA_JANELA, eventos: [] });
// …mas sem NENHUM código de pessoal no mapa da empresa, o zero não é atestado: não medido.
const OBEN_MAPA_SEM_PESSOAL = await rodar(ESTOQUE_GIRO, {
  company: "oben", cps: SO_FORA_DA_JANELA, eventos: [],
  mapa: MAPA_PADRAO.filter((m) => m.fluxo_linha !== "op_pessoal"),
});
// Mapa só da OUTRA empresa: a oben não pode herdar o mapa da colacor_sc (prova o filtro de empresa).
const MAPA_DE_OUTRA_EMPRESA = await rodar(ESTOQUE_GIRO, { company: "oben", mapas: { colacor_sc: MAPA_PADRAO } });
// Mapa incompleto (achado Codex v2.7): código de pessoal (hora extra) e de impostos (ISS) do plano, fora do mapa.
const FORA_DO_MAPA_FOLHA = await rodar(ESTOQUE_GIRO, { cps: [...CPS_PADRAO, cp(20, somarDias(HOJE, 3), 4000, "2.03.89")] });
const FORA_DO_MAPA_TRIBUTO = await rodar(ESTOQUE_GIRO, { cps: [...CPS_PADRAO, cp(21, somarDias(HOJE, 3), 2000, "2.06.07")] });
// Folha sem vencimento na oben (folha centralizada): posição desconhecida não vira zero medido.
const FOLHA_SEM_VENC_OBEN = await rodar(ESTOQUE_GIRO, {
  company: "oben", eventos: [], cps: [...SO_FORA_DA_JANELA, { ...cp(22, HOJE, 40000, "2.03.01"), data_vencimento: null as unknown as string }],
});

type NcgResposta = {
  aco: { cr_aberto: number; estoque: number | null; adiantamentos: number };
  pco: { cp_fornecedor: number; folha_30d: number; tributos_a_pagar: number; total: number };
  valor: number; parcial: boolean;
};
const ncgDe = (r: typeof COMPLETA) => r.corpo.ncg as NcgResposta;
const composicao = (s: Record<string, unknown>) => ({
  cr_aberto: s.ncg_cr_aberto, estoque: s.ncg_estoque, adiantamentos: s.ncg_adiantamentos,
  cp_fornecedor: s.ncg_cp_fornecedor, folha_30d: s.ncg_folha_30d, tributos_a_pagar: s.ncg_tributos_a_pagar,
});

Deno.test("controle: a coluna ncg (total) do snapshot = ncg.valor da resposta", () => {
  for (const [nome, r] of [
    ["completa", COMPLETA], ["parcial", PARCIAL], ["mapa vazio", MAPA_VAZIO], ["tributo só pago", TRIBUTO_SO_PAGO],
    ["sem folha sc", SEM_FOLHA_SC], ["sem folha oben", SEM_FOLHA_OBEN], ["fora do mapa", FORA_DO_MAPA_FOLHA],
  ] as const) {
    igual(r.snapshot.ncg, ncgDe(r).valor, `ncg do snapshot (${nome})`);
  }
});

Deno.test("fixture: a NCG completa tem estoque e a parcial não", () => {
  igual(ncgDe(COMPLETA).parcial, false, "FIXTURE_FRACA: NCG completa saiu parcial");
  igual(ncgDe(PARCIAL).parcial, true, "FIXTURE_FRACA: NCG sem estoque saiu completa");
});

// fornecedor 1234,56 + parcelamento 800 + folha atrasada 45 d 4000 + folha depois da janela 3000
const CP_FORNECEDOR = 9034.56;
// folha na janela = 70000 + 5000 (> recorrente 60000) · tributos = DAS 300 + IRPJ vencido 200
Deno.test("snapshot completo: as 6 colunas ncg_* casam EXATO e fecham com o total", () => {
  igual(
    composicao(COMPLETA.snapshot),
    { cr_aberto: 90435, estoque: 500000, adiantamentos: 450, cp_fornecedor: CP_FORNECEDOR, folha_30d: 75000, tributos_a_pagar: 500 },
    "colunas ncg_* (completa)",
  );
  const n = ncgDe(COMPLETA);
  igual(composicao(COMPLETA.snapshot), { ...n.aco, ...n.pco, total: undefined }, "colunas ≠ resposta ncg.aco/ncg.pco");
  igual(Math.round((COMPLETA.snapshot.ncg as number) * 100), Math.round((90435 + 500000 + 450 - CP_FORNECEDOR - 75000 - 500) * 100), "NCG total");
});

Deno.test("snapshot sem estoque: ncg_estoque NULL (nunca 0), as outras 5 medidas — parcial", () => {
  igual(
    composicao(PARCIAL.snapshot),
    { cr_aberto: 90435, estoque: null, adiantamentos: 450, cp_fornecedor: CP_FORNECEDOR, folha_30d: 75000, tributos_a_pagar: 500 },
    "colunas ncg_* (parcial)",
  );
});

Deno.test("nada conta duas vezes: PCO = Σ CP aberto não-adiantamento (o mapa só redistribui)", () => {
  // Com o CP de folha ≥ recorrente, o max não acrescenta nada. (O controle MAPA_VAZIO roda sem recorrente: com
  // ele, a v2.6 somava o recorrente POR CIMA do CP de folha que não enxergava — prod tem 0 recorrente de folha.)
  const soma = CPS_PADRAO.filter((c) => c.categoria_codigo !== "2.01.98").reduce((s, c) => s + c.saldo, 0);
  igual(Math.round(ncgDe(COMPLETA).pco.total * 100), Math.round(soma * 100), "pco.total (completa)");
  igual(Math.round(ncgDe(MAPA_VAZIO).pco.total * 100), Math.round(soma * 100), "pco.total (mapa vazio)");
  igual(ncgDe(COMPLETA).valor, ncgDe(MAPA_VAZIO).valor, "o mapa mudou o TOTAL da NCG");
});

Deno.test("folha vencida além do limite: fica em cp_fornecedor e vira motivo de confiança com a contagem", () => {
  const motivos = (COMPLETA.corpo.confianca_dados as { motivos: string[] }).motivos;
  igual(motivos.filter((m) => m.startsWith("1 título(s) de folha vencido(s) há mais de 30 dias")).length, 1, "motivo da folha velha");
});

const NAO_MEDIDA = {
  cr_aberto: null, estoque: null, adiantamentos: null, cp_fornecedor: null, folha_30d: null, tributos_a_pagar: null,
};

Deno.test("mapa vazio (estado de prod até a v2.6): composição NÃO medida, tudo em cp_fornecedor", () => {
  igual(composicao(MAPA_VAZIO.snapshot), NAO_MEDIDA, "colunas ncg_* (mapa vazio)");
  igual(ncgDe(MAPA_VAZIO).pco.folha_30d, 0, "folha (mapa vazio)");
  igual(ncgDe(MAPA_VAZIO).pco.tributos_a_pagar, 0, "tributos (mapa vazio)");
});

Deno.test("fonte vazia de tributos (nenhum título aberto do mapa): composição não medida", () => {
  igual(composicao(TRIBUTO_SO_PAGO.snapshot), NAO_MEDIDA, "colunas ncg_* (tributo só pago)");
  igual(composicao(TRIBUTO_PAGO_RESIDUAL.snapshot), NAO_MEDIDA, "colunas ncg_* (tributo pago com saldo residual)");
});

Deno.test("folha medida por uma fonte só: recorrente sozinho ou CP sozinho bastam", () => {
  igual(composicao(SO_RECORRENTE.snapshot).folha_30d, 60000, "só recorrente");
  igual(composicao(SO_CP_FOLHA.snapshot).folha_30d, 75000, "só CP de folha");
});

Deno.test("colacor_sc sem folha na janela e com recorrente encerrado: fonte vazia → não medida", () => {
  igual(composicao(SEM_FOLHA_SC.snapshot), NAO_MEDIDA, "colunas ncg_* (sem folha sc)");
  const motivos = (SEM_FOLHA_SC.corpo.confianca_dados as { motivos: string[] }).motivos;
  igual(motivos.some((m) => m.startsWith("Folha dos próximos 30 dias sem fonte")), true, "motivo de folha sem fonte");
});

Deno.test("folha centralizada: na oben, sem título na janela, folha é ZERO MEDIDO", () => {
  const c = composicao(SEM_FOLHA_OBEN.snapshot);
  igual(c.folha_30d, 0, "folha oben");
  igual(c.cr_aberto, 90435, "composição oben medida");
});

Deno.test("folha centralizada sem código de pessoal no mapa da empresa: zero NÃO atestado → não medida", () => {
  igual(composicao(OBEN_MAPA_SEM_PESSOAL.snapshot), NAO_MEDIDA, "colunas ncg_* (oben sem pessoal no mapa)");
});

Deno.test("mapa ilegível (timeout, corpo nulo, página cheia): a engine LANÇA — nunca grava composição", async () => {
  const cheio = Array.from({ length: 1000 }, (_, i) => ({ omie_codigo: `9.99.${i}`, fluxo_linha: "op_despesas" }));
  const casos: Array<[string, typeof MAPA_FALHA, Cenario]> = [
    ["timeout", "timeout", {}], ["corpo nulo", "corpo-nulo", {}], ["truncado", "nao", { mapa: cheio }],
  ];
  for (const [nome, falha, cen] of casos) {
    MAPA_FALHA = falha;
    try {
      const { res, corpo } = await chamar(ESTOQUE_GIRO, cen);
      igual(res.status, 500, `status (${nome})`);
      igual(snapshots.length, 0, `snapshot gravado (${nome})`);
      igual(JSON.stringify(corpo).includes("fin_categoria_fluxo_mapping"), true, `erro não nomeia a leitura (${nome})`);
    } finally {
      MAPA_FALHA = "nao";
    }
  }
});

Deno.test("mapa é POR EMPRESA: a oben não herda o mapa da colacor_sc", () => {
  igual(composicao(MAPA_DE_OUTRA_EMPRESA.snapshot), NAO_MEDIDA, "colunas ncg_* (mapa de outra empresa)");
});

Deno.test("mapa incompleto: código de pessoal/impostos fora do mapa → parcela não atestada, composição não medida", () => {
  igual(composicao(FORA_DO_MAPA_FOLHA.snapshot), NAO_MEDIDA, "colunas ncg_* (pessoal fora do mapa)");
  igual(composicao(FORA_DO_MAPA_TRIBUTO.snapshot), NAO_MEDIDA, "colunas ncg_* (imposto fora do mapa)");
  const motivos = (FORA_DO_MAPA_FOLHA.corpo.confianca_dados as { motivos: string[] }).motivos;
  igual(motivos.some((m) => m.startsWith("1 título(s) aberto(s) com código de pessoal fora do mapa")), true, "motivo");
  // O título fora do mapa continua no PCO (cp_fornecedor): só a composição deixa de ser afirmada.
  igual(Math.round(ncgDe(FORA_DO_MAPA_FOLHA).pco.cp_fornecedor * 100), Math.round((CP_FORNECEDOR + 4000) * 100), "cp_fornecedor");
});

Deno.test("folha sem vencimento na oben: não vira zero medido", () => {
  igual(composicao(FOLHA_SEM_VENC_OBEN.snapshot), NAO_MEDIDA, "colunas ncg_* (folha sem vencimento)");
});

// ── Helper puro ───────────────────────────────────────────────────────────────────────────────
const BASE = {
  aco: { cr_aberto: 100, estoque: 50 as number | null, adiantamentos: 10 },
  pco: { cp_fornecedor: 40, folha_30d: 20, tributos_a_pagar: 5 },
  valor: 95,
  fontes: { folha: true, tributos: true },
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
      pco: { cp_fornecedor: 0, folha_30d: 0, tributos_a_pagar: 0 }, valor: 9999999999.999, fontes: BASE.fontes,
    }],
    // Achado Codex P2: na fronteira o float aceita 0,05 e o numeric do banco não; o helper recusa antes.
    ["fronteira do fechamento", {
      aco: { cr_aberto: 0.1, estoque: 0.2, adiantamentos: 0 },
      pco: { cp_fornecedor: 0, folha_30d: 0, tributos_a_pagar: 0 }, valor: 0.35000000000000003, fontes: BASE.fontes,
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


Deno.test("helper: fonte de folha ou de tributos ausente → as 6 NULL", () => {
  igual(colunasComposicaoNcg({ ...BASE, fontes: { folha: false, tributos: true } }, true), NULAS, "sem folha");
  igual(colunasComposicaoNcg({ ...BASE, fontes: { folha: true, tributos: false } }, true), NULAS, "sem tributos");
});
