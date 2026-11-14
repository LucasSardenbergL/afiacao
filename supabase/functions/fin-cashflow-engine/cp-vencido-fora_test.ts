// CP vencido FORA da projeção — só VISÍVEL, nenhum saldo muda (decisão do founder, 14/11/2026).
//
// O laço de semanas de `gerarSemanas` só põe um CP numa semana se `data_vencimento` ∈ [início, fim]
// dela. O CP aberto vencido ANTES da segunda-feira corrente não cai em semana nenhuma (diagnóstico:
// docs/historico/cp-atrasado-fora-da-projecao.md). Até a conferência título a título decidir se é
// status velho no Omie (débito automático sem baixa) ou dívida real, o motor só o EXPÕE:
// `cp_vencido_fora_projecao` na resposta e colunas dedicadas no snapshot.
//
// O que este teste prova, pelo HANDLER e com um PostgREST falso:
//   1. o campo novo casa EXATO (contagem, total a centavo, mais antigo, faixas de idade) — e a borda:
//      vencimento == segunda-feira corrente entra na semana 0 e NÃO conta; a véspera conta;
//   2. o snapshot gravado leva as mesmas 7 colunas;
//   3. IDENTIDADE: a mesma fixture COM e SEM os CP vencidos dá `semanas` (todas as saídas, saldos e
//      totais), `apos_horizonte` e `dias_cobertura` IDÊNTICOS — o campo novo não mexe em saldo;
//   4. sem CP vencido o campo é ZERO REAL (0 / 0 / null), não ausência;
//   5. denominador: saídas de CP nas semanas + vencido fora + CP depois do horizonte = CP aberto total.
// O caso 3 é o CONTROLE VERDE da linha de base: passa no código de antes (as semanas já ignoravam
// esses títulos) enquanto 1, 2 e 4 ficam vermelhos — o vermelho é do assert, não do caminho.
//
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/fin-cashflow-engine/
import { ENV_TESTE, igual, instalarHarness } from "../_shared/harness-handler_test.ts";
import { hojeSP, somarDias } from "../_shared/hoje-sp.ts";

const h = instalarHarness();
// Import COMPUTADO (ver index_test.ts): o type-check do index.ts é do gate `edges:typecheck`.
await import(new URL("./index.ts", import.meta.url).href);
const handler = h.handler();

const HOJE = hojeSP();
/** Segunda-feira da semana de `HOJE` — a MESMA conta do motor (`inicioSemanaUTC`). */
function segundaDe(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  const dia = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dia === 0 ? -6 : 1 - dia));
  return d.toISOString().slice(0, 10);
}
const SEGUNDA = segundaDe(HOJE);
const VESPERA = somarDias(SEGUNDA, -1);

// ── Fixture ───────────────────────────────────────────────────────────────────────────────────
const uuid = (n: number, tabela: number) =>
  `${((n * 2654435761) >>> 0).toString(16).padStart(8, "0")}-000${tabela}-4000-8000-${n.toString(16).padStart(12, "0")}`;
const cp = (n: number, venc: string | null, saldo: number, status: string) => ({
  id: uuid(n, 2), saldo, valor_documento: saldo, valor_pago: 0,
  data_emissao: somarDias(HOJE, -500), data_vencimento: venc, data_pagamento: null,
  status_titulo: status, categoria_codigo: "2.05.01",
});

// Os que DEVEM contar (abertos, saldo > 0, vencidos antes da segunda): um por faixa de idade.
const VENCIDOS = [
  cp(1, VESPERA, 1000.1, "ATRASADO"),                  // 1–7 dias → ate_30 (a BORDA de cima)
  cp(2, somarDias(HOJE, -45), 2000, "ATRASADO"),       // de_31_a_60
  cp(3, somarDias(HOJE, -100), 3000.33, "VENCIDO"),    // de_61_a_180
  cp(4, somarDias(HOJE, -400), 4000, "ABERTO"),        // acima_180 — o mais antigo
];
// Os que NÃO podem contar.
const DEMAIS = [
  cp(10, somarDias(HOJE, -50), 999, "PAGO"),           // liquidado
  cp(11, somarDias(HOJE, -20), 0, "ATRASADO"),         // saldo zero
  cp(12, null, 777, "ATRASADO"),                       // sem vencimento
  cp(13, SEGUNDA, 500, "A VENCER"),                    // vence NA segunda → semana 0, não conta
  cp(14, somarDias(HOJE, 30), 700, "A VENCER"),        // dentro do horizonte
  cp(15, somarDias(HOJE, 200), 650, "A VENCER"),       // depois do horizonte (13 semanas)
  cp(16, somarDias(HOJE, -60), 888, "CANCELADO"),      // a query já filtra
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
  adiantamento_categorias_codigos: [],
};
const RPCS: Record<string, unknown> = {
  fin_titulo_baixas_cr_mapa: { total: 0, pares: [] },
  fin_capital_giro_prazos_empresa: { existe: true, pmr: 40, pmp: 30, pmr_cobertura: 0.8, pmp_cobertura: 0.7 },
  fin_estoque_giro_valor: [{ valor_giro: 500000, skus_giro: 900, cobertura_pct: 97, valor_sem_classificacao: 0 }],
};

// ── PostgREST falso ───────────────────────────────────────────────────────────────────────────
let CPS: Array<Record<string, unknown>> = [];
const snapshots: Array<Record<string, unknown>> = [];
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
async function rodar(cps: Array<Record<string, unknown>>) {
  CPS = cps;
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

const COM = await rodar([...VENCIDOS, ...DEMAIS]);
const SEM = await rodar([...DEMAIS]);

const ESPERADO = {
  qtd: 4,
  total: 10000.43,
  vencimento_mais_antigo: somarDias(HOJE, -400),
  faixas: { ate_30: 1000.1, de_31_a_60: 2000, de_61_a_180: 3000.33, acima_180: 4000 },
};

type Semana = { inicio: string; fim: string; saidas: Array<{ origem: string; valor: number; id_origem: string }> };

Deno.test("fixture: há CP vencido de verdade e a borda da segunda está na semana 0", () => {
  const semanas = COM.corpo.semanas as Semana[];
  if (semanas[0].inicio !== SEGUNDA) throw new Error(`FIXTURE_FRACA: semana 0 começa em ${semanas[0].inicio}, não em ${SEGUNDA}`);
  const naSemana0 = semanas[0].saidas.some((s) => s.id_origem === uuid(13, 2));
  if (!naSemana0) throw new Error("FIXTURE_FRACA: o CP que vence NA segunda não está na semana 0");
  const algumVencidoNasSemanas = semanas.some((s) => s.saidas.some((x) => VENCIDOS.some((v) => v.id === x.id_origem)));
  if (algumVencidoNasSemanas) throw new Error("FIXTURE_FRACA: um CP vencido apareceu numa semana — o defeito mudou de forma");
});

Deno.test("identidade: COM e SEM os CP vencidos, semanas, saldos, saídas e cobertura são IDÊNTICOS", () => {
  igual(COM.corpo.semanas, SEM.corpo.semanas, "semanas (saídas, entradas, saldos) mudaram");
  igual(COM.corpo.apos_horizonte, SEM.corpo.apos_horizonte, "apos_horizonte mudou");
  const cob = (r: typeof COM) => (r.corpo.indicadores as { dias_cobertura: number | null }).dias_cobertura;
  igual(cob(COM), cob(SEM), "dias_cobertura mudou");
  igual(COM.snapshot.dados, SEM.snapshot.dados, "semanas do snapshot mudaram");
  igual(COM.snapshot.dias_cobertura, SEM.snapshot.dias_cobertura, "dias_cobertura do snapshot mudou");
});

Deno.test("resposta: cp_vencido_fora_projecao casa exato (contagem, total, mais antigo, faixas)", () => {
  igual(COM.corpo.cp_vencido_fora_projecao, ESPERADO, "cp_vencido_fora_projecao");
});

Deno.test("snapshot: as 7 colunas dedicadas levam os mesmos números", () => {
  const s = COM.snapshot;
  igual(
    {
      qtd: s.cp_vencido_fora_qtd, total: s.cp_vencido_fora_total, mais_antigo: s.cp_vencido_fora_mais_antigo,
      ate_30: s.cp_vencido_fora_ate_30, de_31_a_60: s.cp_vencido_fora_31_60,
      de_61_a_180: s.cp_vencido_fora_61_180, acima_180: s.cp_vencido_fora_acima_180,
    },
    {
      qtd: 4, total: 10000.43, mais_antigo: somarDias(HOJE, -400),
      ate_30: 1000.1, de_31_a_60: 2000, de_61_a_180: 3000.33, acima_180: 4000,
    },
    "colunas cp_vencido_fora_* do snapshot",
  );
});

Deno.test("sem CP vencido: zero REAL (0 títulos, R$ 0, sem data) — não ausência", () => {
  igual(
    SEM.corpo.cp_vencido_fora_projecao,
    { qtd: 0, total: 0, vencimento_mais_antigo: null, faixas: { ate_30: 0, de_31_a_60: 0, de_61_a_180: 0, acima_180: 0 } },
    "cp_vencido_fora_projecao sem vencidos",
  );
  igual(SEM.snapshot.cp_vencido_fora_qtd, 0, "cp_vencido_fora_qtd sem vencidos");
  igual(SEM.snapshot.cp_vencido_fora_total, 0, "cp_vencido_fora_total sem vencidos");
});

Deno.test("denominador: CP nas semanas + vencido fora + depois do horizonte = CP aberto total", () => {
  const semanas = COM.corpo.semanas as Semana[];
  const fim = semanas[semanas.length - 1].fim;
  const nasSemanas = semanas.reduce((s, w) => s + w.saidas.filter((x) => x.origem === "cp_omie").reduce((a, x) => a + x.valor, 0), 0);
  const abertos = [...VENCIDOS, ...DEMAIS].filter((c) =>
    c.data_vencimento && c.saldo > 0 && !["PAGO", "CANCELADO"].includes(c.status_titulo)
  );
  const depois = abertos.filter((c) => (c.data_vencimento as string) > fim).reduce((a, c) => a + c.saldo, 0);
  const total = abertos.reduce((a, c) => a + c.saldo, 0);
  const fora = (COM.corpo.cp_vencido_fora_projecao as { total: number } | undefined)?.total;
  if (fora === undefined) throw new Error("cp_vencido_fora_projecao ausente");
  igual(Math.round((nasSemanas + fora + depois) * 100) / 100, Math.round(total * 100) / 100, "a soma não fecha com o CP aberto");
});
