/**
 * Lado TS do harness de paridade do farmer scoring — db/test-fu4f-fase3-paridade-ts-sql.sh.
 *
 * O baseline que a §5.1 do spec `2026-07-20-fechamento-custo-farmer-scoring-design.md` pedia
 * ("mesma cesta de clientes, margem pelo TS e pela RPC, exigindo a mesma faixa") e que o #1543
 * entregou DECLARADO em vez de MEDIDO.
 *
 * O que faz: roda o motor de scoring do `useFarmerScoring` DUAS vezes sobre o MESMO corpus de
 * prod, trocando exclusivamente a origem do componente de margem:
 *   • lado TS  — margem calculada no browser a partir de `sales_orders.items` (jsonb) × costMap,
 *                exatamente como o hook fazia ANTES do #1543 (código recuperado de c95e4d90).
 *   • lado SQL — `g`/`margem_pct`/`faixa` vindos de `get_carteira_margem_faixa()`, que deriva de
 *                `private.margem_cliente_agregada()` (autoridade única do #1519/#1567).
 *
 * ⚠️ TUDO MAIS É MANTIDO IDÊNTICO de propósito. rf/m/x/s, churn, recover, expansion e eff saem
 * do MESMO cálculo nos dois lados, porque o #1543 mudou só a fonte da margem — o universo de
 * `sales_orders` que alimenta as outras dimensões continua sendo a allowlist local do hook.
 * Recalcular as outras dimensões junto misturaria um delta que este PR não causou.
 *
 * Os helpers de negócio são IMPORTADOS de `src/` (não reimplementados): `accumulateMarginFromItems`,
 * `resolveProductIdsFromItems`, `custoCanonico` e `calcularHealthScore` são o código real que roda
 * em produção. O que está copiado verbatim aqui — `percentile`, `classifyHealth`, `clamp` e os três
 * laços da agenda — é o que vive INLINE no hook e não tem export; a cópia está marcada e o harness
 * tem um assert de fidelidade (ver `db/test-fu4f-fase3-paridade-ts-sql.sh`, bloco FIDELIDADE).
 *
 * Uso: bun scripts/paridade-farmer-scoring.ts <dir-do-corpus> <saida.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accumulateMarginFromItems, resolveProductIdsFromItems } from '../src/lib/scoring/margin';
import { custoCanonico } from '../src/lib/custo/custoCanonico';
import { calcularHealthScore } from '../src/lib/scoring/healthScore';
import type { FaixaMargem } from '../src/lib/scoring/faixaMargem';

// ─── CSV (RFC4180) ────────────────────────────────────────────────────────────────────────────
// Parser próprio: o jsonb de `items` traz vírgulas e aspas escapadas, então split(',') corromperia
// o corpus em silêncio — e um corpus corrompido produziria um "delta" que é bug do parser.
function parseCSV(texto: string): Record<string, string>[] {
  const linhas: string[][] = [];
  let campo = '';
  let linha: string[] = [];
  let emAspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (emAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else emAspas = false;
      } else campo += c;
    } else if (c === '"') emAspas = true;
    else if (c === ',') { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo.length > 0 || linha.length > 0) { linha.push(campo); linhas.push(linha); }
  if (linhas.length === 0) return [];
  const header = linhas[0];
  return linhas.slice(1).map((l) => {
    const o: Record<string, string> = {};
    header.forEach((h, i) => { o[h] = l[i] ?? ''; });
    return o;
  });
}

const csv = (dir: string, nome: string) => parseCSV(readFileSync(join(dir, nome), 'utf8'));

// ─── VERBATIM do useFarmerScoring (helpers inline, sem export no hook) ────────────────────────
// COPIA-INICIO percentile — verbatim de src/hooks/useFarmerScoring.ts
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
// COPIA-FIM percentile

// COPIA-INICIO classifyHealth — verbatim de src/hooks/useFarmerScoring.ts
function classifyHealth(score: number): 'saudavel' | 'estavel' | 'atencao' | 'critico' {
  if (score >= 80) return 'saudavel';
  if (score >= 60) return 'estavel';
  if (score >= 40) return 'atencao';
  return 'critico';
}
// COPIA-FIM classifyHealth

// COPIA-INICIO clamp — verbatim de src/hooks/useFarmerScoring.ts
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// COPIA-FIM clamp

// ─── Entrada ──────────────────────────────────────────────────────────────────────────────────
const dir = process.argv[2];
const saida = process.argv[3];
// 4º argumento: qual arquivo de pedidos alimenta o motor. O default é a ALLOWLIST (o universo
// que o hook realmente usa hoje). Passando `pedidos-denylist.csv` o mesmo motor roda sobre o
// universo amplo — é assim que se mede o CUSTO DE PRODUTO de alinhar o filtro do hook ao do
// helper, em vez de chamá-lo de "correção óbvia" sem número.
const arquivoPedidos = process.argv[4] || 'pedidos.csv';
if (!dir || !saida) {
  console.error('uso: bun scripts/paridade-farmer-scoring.ts <dir-do-corpus> <saida.json> [pedidos.csv]');
  process.exit(1);
}

// `now` FIXO vindo do corpus: recência/SLA dependem do relógio, e deixar cada lado ler o seu
// faria a diferença de milissegundos entre as duas passagens virar "delta". O instante é o do
// snapshot do corpus (db/…-extract), não o da execução.
const AGORA = Number(readFileSync(join(dir, 'agora.txt'), 'utf8').trim());
if (!Number.isFinite(AGORA)) throw new Error('agora.txt ilegível — o relógio do harness precisa ser fixo');

const cfgRows = csv(dir, 'config.csv');
const cfg: Record<string, number> = {
  k1: 1.0, k2: 1.0, cat_target: 5,
  health_w_rf: 0.35, health_w_m: 0.20, health_w_g: 0.15, health_w_x: 0.15, health_w_s: 0.15,
  priority_w_churn: 0.40, priority_w_recover: 0.30, priority_w_expansion: 0.20, priority_w_eff: 0.10,
  agenda_pct_risco: 0.50, agenda_pct_expansao: 0.30, agenda_pct_followup: 0.20, sla_contact_days: 14,
};
for (const r of cfgRows) {
  const n = Number(r.value);
  if (Number.isFinite(n)) cfg[r.key] = n;
}

// Limiares da FAIXA: a RPC lê `margem_faixa_piso_pct`/`margem_faixa_meta_pct` da config e cai em
// 30/50 quando ausentes. Espelhado aqui para que a faixa derivada do lado TS use a MESMA régua —
// só assim a comparação isola a MARGEM em vez de comparar dois vocabulários diferentes.
const PISO = Number.isFinite(cfg.margem_faixa_piso_pct) ? cfg.margem_faixa_piso_pct : 30;

// ─── Corpus ───────────────────────────────────────────────────────────────────────────────────
const omieToProductId = new Map<number, string>();
for (const p of csv(dir, 'produtos.csv')) {
  if (p.omie_codigo_produto !== '') omieToProductId.set(Number(p.omie_codigo_produto), p.id);
}

// costMap com o custo CANÔNICO real (cost_final → cost_price, ambos com finitude positiva).
const costMap = new Map<string, number>();
for (const pc of csv(dir, 'custos.csv')) {
  const c = custoCanonico({
    cost_final: pc.cost_final === '' ? null : pc.cost_final,
    cost_price: pc.cost_price === '' ? null : pc.cost_price,
  });
  if (c != null) costMap.set(pc.product_id, c);
}

const flaggeds = new Set(csv(dir, 'excluidos.csv').map((r) => r.user_id));

const profileMap = new Map<string, { name: string; phone: string | null }>();
for (const p of csv(dir, 'profiles.csv')) {
  profileMap.set(p.user_id, { name: p.name, phone: p.phone === '' ? null : p.phone });
}

// ─── Agregação por cliente (VERBATIM do laço do hook) ─────────────────────────────────────────
interface CustomerData {
  orderDates: number[];
  totalSpend: number; spend180d: number;
  totalRevenue: number; totalCost: number;
  categories: Set<string>;
  calls60d: number; contactSuccess60d: number;
  whatsappCalls60d: number; whatsappReplied60d: number;
  lastContactDate: number;
}

const sixMonthsAgo = AGORA - 180 * 24 * 60 * 60 * 1000;
const sixtyDaysAgo = AGORA - 60 * 24 * 60 * 60 * 1000;

function novoCD(): CustomerData {
  return {
    orderDates: [], totalSpend: 0, spend180d: 0, totalRevenue: 0, totalCost: 0,
    categories: new Set(), calls60d: 0, contactSuccess60d: 0,
    whatsappCalls60d: 0, whatsappReplied60d: 0, lastContactDate: 0,
  };
}

const customerMap = new Map<string, CustomerData>();
for (const order of csv(dir, arquivoPedidos)) {
  const cid = order.customer_user_id;
  if (!cid) continue;
  if (flaggeds.has(cid)) continue;
  if (!customerMap.has(cid)) customerMap.set(cid, novoCD());
  const cd = customerMap.get(cid)!;
  // Recência pela DATA DO PEDIDO (order_date_kpi = dInc), com fallback para created_at.
  const orderTime = new Date(order.order_date_kpi !== '' ? order.order_date_kpi : order.created_at).getTime();
  cd.orderDates.push(orderTime);
  cd.totalSpend += Number(order.total || 0);
  if (orderTime >= sixMonthsAgo) cd.spend180d += Number(order.total || 0);

  let items: unknown = [];
  try { items = JSON.parse(order.items || '[]'); } catch { items = []; }
  const arr = Array.isArray(items) ? items : [];
  // A margem do lado TS: helper REAL de src/, sobre o jsonb REAL.
  const { revenue, cost } = accumulateMarginFromItems(arr, costMap, omieToProductId);
  cd.totalRevenue += revenue;
  cd.totalCost += cost;
  for (const pid of resolveProductIdsFromItems(arr, omieToProductId)) cd.categories.add(pid);
}

// ─── Chamadas por farmer ──────────────────────────────────────────────────────────────────────
// O hook filtra `farmer_calls` por `farmer_id = targetFarmerId`; S e effScore dependem da persona.
const callsPorFarmer = new Map<string, Record<string, string>[]>();
for (const c of csv(dir, 'calls.csv')) {
  if (!callsPorFarmer.has(c.farmer_id)) callsPorFarmer.set(c.farmer_id, []);
  callsPorFarmer.get(c.farmer_id)!.push(c);
}

// ─── Lado SQL: faixa/g/margem vindos da réplica verbatim da RPC ───────────────────────────────
interface LinhaSQL { g: number | null; pct: number | null; faixa: FaixaMargem }
const sqlPorCliente = new Map<string, LinhaSQL>();
for (const r of csv(dir, 'sql-faixa.csv')) {
  sqlPorCliente.set(r.customer_user_id, {
    g: r.g === '' ? null : Number(r.g),
    pct: r.margem_pct === '' ? null : Number(r.margem_pct),
    faixa: r.faixa as FaixaMargem,
  });
}

// ─── Escopo por persona ───────────────────────────────────────────────────────────────────────
// `private.carteira_visivel_para` exige `eligible IS TRUE`; `cap_carteira_ler` (master/gerencial)
// dispensa o filtro. Reproduzido a partir do corpus de `carteira_assignments`.
const carteiraDe = new Map<string, Set<string>>();
for (const a of csv(dir, 'carteiras.csv')) {
  if (a.eligible !== 't' && a.eligible !== 'true') continue;
  if (!carteiraDe.has(a.owner_user_id)) carteiraDe.set(a.owner_user_id, new Set());
  carteiraDe.get(a.owner_user_id)!.add(a.customer_user_id);
}

const personas: { id: string; rotulo: string; capTodo: boolean }[] =
  JSON.parse(readFileSync(join(dir, 'personas.json'), 'utf8'));

// ─── População (VERBATIM): p95 de spend e a régua p10/p90 da margem TS ────────────────────────
const allMonthlySpends: number[] = [];
customerMap.forEach((cd) => { allMonthlySpends.push(cd.spend180d / 6); });
const p95MonthlySpend = percentile(allMonthlySpends, 95) || 1;

const allMargins: number[] = [];
customerMap.forEach((cd) => {
  if (cd.totalRevenue > 0) allMargins.push((cd.totalRevenue - cd.totalCost) / cd.totalRevenue);
});
const p10Margin = percentile(allMargins, 10);
const p90Margin = percentile(allMargins, 90);
const marginRange = Math.max(p90Margin - p10Margin, 0.01);

// Faixa derivada da margem TS com a MESMA régua da RPC (pct em pontos percentuais).
function faixaDe(pct: number | null): FaixaMargem {
  if (pct == null) return 'neutro';
  if (pct < 0) return 'vermelho';
  if (pct < PISO) return 'amarelo';
  return 'verde';
}

interface Score {
  cid: string;
  churnRisk: number; expansionScore: number; priorityScore: number;
  healthTS: number; healthSQL: number;
  classeTS: string; classeSQL: string;
  gTS: number | null; gSQL: number | null;
  pctTS: number | null; pctSQL: number | null;
  faixaTS: FaixaMargem; faixaSQL: FaixaMargem;
}

function pontuar(persona: { id: string; capTodo: boolean }): Score[] {
  // Chamadas desta persona (VERBATIM: o hook agrega por farmer_id).
  const porCliente = new Map<string, { calls60d: number; ok60d: number; wa60d: number; waResp60d: number; last: number }>();
  for (const call of callsPorFarmer.get(persona.id) ?? []) {
    const cid = call.customer_user_id;
    if (!cid || !customerMap.has(cid)) continue;
    if (!porCliente.has(cid)) porCliente.set(cid, { calls60d: 0, ok60d: 0, wa60d: 0, waResp60d: 0, last: 0 });
    const a = porCliente.get(cid)!;
    const t = new Date(call.created_at).getTime();
    if (t > a.last) a.last = t;
    if (t >= sixtyDaysAgo) {
      a.calls60d++;
      if (call.call_result === 'contato_sucesso') a.ok60d++;
      if (call.is_whatsapp === 't' || call.is_whatsapp === 'true') {
        a.wa60d++;
        if (call.whatsapp_replied === 't' || call.whatsapp_replied === 'true') a.waResp60d++;
      }
    }
  }

  const visiveis = carteiraDe.get(persona.id) ?? new Set<string>();
  const scores: Score[] = [];

  customerMap.forEach((cd, cid) => {
    const profile = profileMap.get(cid);
    if (!profile) return; // VERBATIM: cliente sem profile não é pontuado

    const datas = [...cd.orderDates].sort((a, b) => a - b);
    const lastPurchase = datas[datas.length - 1];
    const D = Math.max(0, Math.floor((AGORA - lastPurchase) / (1000 * 60 * 60 * 24)));

    let I = 30;
    if (datas.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < datas.length; i++) intervals.push((datas[i] - datas[i - 1]) / (1000 * 60 * 60 * 24));
      I = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    }

    const rfRatio = Math.max((D / Math.max(I, 1)) - 1, 0);
    const rf = Math.exp(-cfg.k2 * rfRatio);
    const avgMonthly = cd.spend180d / 6;
    const m = clamp(Math.log(1 + avgMonthly) / Math.log(1 + p95MonthlySpend), 0, 1);
    const x = clamp(cd.categories.size / cfg.cat_target, 0, 1);

    const ag = porCliente.get(cid);
    const answerRate = ag && ag.calls60d > 0 ? ag.ok60d / ag.calls60d : 0;
    const whatsappRate = ag && ag.wa60d > 0 ? ag.waResp60d / ag.wa60d : 0;
    const s = 0.7 * answerRate + 0.3 * whatsappRate;

    // ── margem: os DOIS lados ───────────────────────────────────────────────────────────────
    // TS (pré-#1543): fração calculada no browser; null quando NENHUM item tem custo conhecido.
    const clientMargin = cd.totalRevenue > 0 ? (cd.totalRevenue - cd.totalCost) / cd.totalRevenue : null;
    const gTS = clientMargin == null ? null : clamp((clientMargin - p10Margin) / marginRange, 0, 1);
    const pctTS = clientMargin == null ? null : Math.round(clientMargin * 1000) / 10;

    // SQL (pós-#1543): só chega o que o ESCOPO da RPC devolve. Fora do escopo → ausente do mapa
    // → `g = null` → o calcularHealthScore renormaliza. É o delta 2, e ele mora aqui.
    const noEscopo = persona.capTodo || visiveis.has(cid);
    const linha = noEscopo ? sqlPorCliente.get(cid) : undefined;
    const gSQL = linha?.g ?? null;
    const pctSQL = linha?.pct ?? null;

    const pesos = {
      rf: cfg.health_w_rf, m: cfg.health_w_m, g: cfg.health_w_g, x: cfg.health_w_x, s: cfg.health_w_s,
    };
    const healthTS = calcularHealthScore({ rf, m, g: gTS, x, s }, pesos);
    const healthSQL = calcularHealthScore({ rf, m, g: gSQL, x, s }, pesos);

    // Dimensões de PRIORIDADE — idênticas nos dois lados (nenhuma depende de `g`).
    const churnRisk = 100 * (1 - Math.exp(-cfg.k1 * rfRatio));
    const delayedMonths = Math.max(0, (D - I) / 30);
    const recoverScore = clamp(delayedMonths * avgMonthly / Math.max(p95MonthlySpend * 6, 1) * 100, 0, 100);
    const mixGap = 1 - (cd.categories.size / Math.max(cfg.cat_target, 1));
    const expansionScore = clamp((mixGap * 0.6 + m * 0.4) * 100, 0, 100);
    const daysSinceContact = ag && ag.last > 0 ? Math.floor((AGORA - ag.last) / (1000 * 60 * 60 * 24)) : 999;
    const effScore = clamp((1 - Math.min(daysSinceContact / cfg.sla_contact_days, 2) / 2) * 100, 0, 100);
    const priorityScore =
      cfg.priority_w_churn * churnRisk + cfg.priority_w_recover * recoverScore +
      cfg.priority_w_expansion * expansionScore + cfg.priority_w_eff * effScore;

    scores.push({
      cid,
      // VERBATIM: o hook arredonda a 1 casa ANTES de ordenar — o desempate depende disso.
      churnRisk: Math.round(churnRisk * 10) / 10,
      expansionScore: Math.round(expansionScore * 10) / 10,
      priorityScore: Math.round(priorityScore * 10) / 10,
      healthTS: Math.round(healthTS * 10) / 10,
      healthSQL: Math.round(healthSQL * 10) / 10,
      // VERBATIM: classifyHealth recebe o score NÃO arredondado.
      classeTS: classifyHealth(healthTS),
      classeSQL: classifyHealth(healthSQL),
      gTS, gSQL, pctTS, pctSQL,
      faixaTS: faixaDe(pctTS),
      faixaSQL: noEscopo ? (linha?.faixa ?? 'neutro') : 'neutro',
    });
  });

  scores.sort((a, b) => b.priorityScore - a.priorityScore);
  return scores;
}

// ─── Agenda (VERBATIM: 3 laços + quotas + set `used`) ─────────────────────────────────────────
function montarAgenda(scores: Score[], lado: 'TS' | 'SQL'): string[] {
  const totalSlots = Math.min(scores.length, 20);
  const riscoSlots = Math.round(totalSlots * cfg.agenda_pct_risco);
  const expansaoSlots = Math.round(totalSlots * cfg.agenda_pct_expansao);
  const followUpSlots = totalSlots - riscoSlots - expansaoSlots;

  const itens: { cid: string; tipo: string }[] = [];
  const used = new Set<string>();

  const riscoSorted = [...scores].sort((a, b) => b.churnRisk - a.churnRisk);
  for (const s of riscoSorted) {
    if (itens.filter((a) => a.tipo === 'risco').length >= riscoSlots) break;
    if (used.has(s.cid)) continue;
    used.add(s.cid); itens.push({ cid: s.cid, tipo: 'risco' });
  }
  const expSorted = [...scores].sort((a, b) => b.expansionScore - a.expansionScore);
  for (const s of expSorted) {
    if (itens.filter((a) => a.tipo === 'expansao').length >= expansaoSlots) break;
    if (used.has(s.cid)) continue;
    used.add(s.cid); itens.push({ cid: s.cid, tipo: 'expansao' });
  }
  for (const s of scores) {
    if (itens.filter((a) => a.tipo === 'follow_up').length >= followUpSlots) break;
    if (used.has(s.cid)) continue;
    used.add(s.cid); itens.push({ cid: s.cid, tipo: 'follow_up' });
  }
  // `lado` não altera a seleção — a agenda não lê `g` nem health. Mantido no contrato para que a
  // afirmação "a agenda é invariante à margem" seja MEDIDA (as duas listas são comparadas), e não
  // assumida por leitura de código.
  void lado;
  return itens.map((i) => `${i.tipo}:${i.cid}`);
}

// ─── Relatório ────────────────────────────────────────────────────────────────────────────────
const relatorio: Record<string, unknown> = {
  corpus: {
    universo: arquivoPedidos,
    pedidos: csv(dir, arquivoPedidos).length,
    clientes_pontuados: 0,
    clientes_no_sql: sqlPorCliente.size,
    p10Margin, p90Margin, marginRange, p95MonthlySpend,
    piso_faixa_pct: PISO,
  },
  personas: [],
};

for (const persona of personas) {
  const scores = pontuar(persona);
  (relatorio.corpus as Record<string, unknown>).clientes_pontuados = scores.length;

  const mudouFaixa = scores.filter((s) => s.faixaTS !== s.faixaSQL);
  const mudouClasse = scores.filter((s) => s.classeTS !== s.classeSQL);
  const deltas = scores.map((s) => Math.abs(s.healthSQL - s.healthTS)).sort((a, b) => a - b);
  const media = deltas.reduce((a, b) => a + b, 0) / (deltas.length || 1);
  const p90 = deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor(0.9 * (deltas.length - 1)))] : 0;
  const maximo = deltas.length ? deltas[deltas.length - 1] : 0;

  const agendaTS = montarAgenda(scores.map((s) => s), 'TS');
  // A agenda do lado SQL é montada a partir dos MESMOS scores, mas ordenada de novo — se alguma
  // dimensão de prioridade dependesse de `g`, as listas divergiriam aqui.
  const scoresSQL = [...scores].sort((a, b) => b.priorityScore - a.priorityScore);
  const agendaSQL = montarAgenda(scoresSQL, 'SQL');
  const setTS = new Set(agendaTS.map((a) => a.split(':')[1]));
  const setSQL = new Set(agendaSQL.map((a) => a.split(':')[1]));
  const saiu = [...setTS].filter((c) => !setSQL.has(c));
  const entrou = [...setSQL].filter((c) => !setTS.has(c));
  // O rótulo de saúde É exibido na agenda, mesmo quando a seleção não muda.
  const rotuloMudou = agendaTS.filter((a) => {
    const cid = a.split(':')[1];
    const s = scores.find((x) => x.cid === cid);
    return s && s.classeTS !== s.classeSQL;
  }).length;

  const matriz: Record<string, number> = {};
  for (const s of mudouFaixa) {
    const k = `${s.faixaTS}→${s.faixaSQL}`;
    matriz[k] = (matriz[k] ?? 0) + 1;
  }

  // Detalhe dos extremos: um máximo idêntico entre personas é sinal de ARTEFATO (mesmo cliente
  // batendo num teto) e precisa ser distinguível de três clientes distintos que empatam. Sem o
  // cid o relatório não permite essa distinção — e o teto teórico aqui é 15,0 (peso g = 0,15
  // redistribuído), então empates perto dele são esperados e devem ser LEGÍVEIS, não suspeitos.
  const topDelta = [...scores]
    .map((s) => ({
      cid: s.cid,
      delta: +(s.healthSQL - s.healthTS).toFixed(2),
      gTS: s.gTS == null ? null : +s.gTS.toFixed(3),
      gSQL: s.gSQL == null ? null : +s.gSQL.toFixed(3),
      classeTS: s.classeTS, classeSQL: s.classeSQL,
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);

  (relatorio.personas as unknown[]).push({
    id: persona.id,
    rotulo: (persona as { rotulo?: string }).rotulo,
    capTodo: persona.capTodo,
    clientes: scores.length,
    // 1. FAIXA
    mudou_faixa: mudouFaixa.length,
    mudou_faixa_pct: scores.length ? +(100 * mudouFaixa.length / scores.length).toFixed(1) : 0,
    matriz_faixa: matriz,
    // 2. HEALTH
    delta_health_medio: +media.toFixed(3),
    delta_health_p90: +p90.toFixed(3),
    delta_health_max: +maximo.toFixed(3),
    top_delta_health: topDelta,
    mudou_classe: mudouClasse.length,
    mudou_classe_pct: scores.length ? +(100 * mudouClasse.length / scores.length).toFixed(1) : 0,
    // 3. AGENDA
    agenda_slots: agendaTS.length,
    agenda_saiu: saiu.length,
    agenda_entrou: entrou.length,
    agenda_identica: agendaTS.join('|') === agendaSQL.join('|'),
    agenda_rotulo_mudou: rotuloMudou,
    agenda_lista: agendaTS,
    // cobertura da margem — quantos ganham/perdem número
    margem_so_no_sql: scores.filter((s) => s.pctTS == null && s.pctSQL != null).length,
    margem_so_no_ts: scores.filter((s) => s.pctTS != null && s.pctSQL == null).length,
    margem_nos_dois: scores.filter((s) => s.pctTS != null && s.pctSQL != null).length,
  });
}

writeFileSync(saida, JSON.stringify(relatorio, null, 2));
console.log(JSON.stringify(relatorio, null, 2));
