/**
 * Quanto custaria GATEAR o componente `g` de `public.get_carteira_margem_faixa()`.
 *
 * Contexto: a revisão adversarial do #1723 (Codex gpt-5.6-sol, 2026-08-13) mostrou que `g` sai sem
 * gate de custo e é uma transformação AFIM da margem (`margem_pct = A + B*g`), enquanto o campo
 * `motivo` fornece ÂNCORAS ABSOLUTAS (piso 30 / meta 50) que permitem calibrar A e B numa única
 * resposta — reconstruindo a margem de toda a carteira sem escrever nada. Fechar isso gateando `g`
 * para NULL é a opção óbvia, e é justamente a que muda PRODUTO: `calcularHealthScore` renormaliza
 * os pesos quando `g` é null, então o health score de quem não tem `cap_custo_ler` MUDA.
 *
 * Este script mede esse custo em cima do corpus REAL de prod, para não decidir no escuro — o mesmo
 * método do baseline de paridade do #1721, do qual ele é derivado.
 *
 * O que compara, por persona:
 *   • ATUAL — `g` como a RPC devolve hoje (sai para todos, com ou sem cap_custo_ler);
 *   • GATE  — `g` NULL para quem NÃO tem `cap_custo_ler` (as demais dimensões intactas).
 *
 * ⚠️ Tudo mais é mantido IDÊNTICO de propósito: rf/m/x/s, churn, recover, expansion e priority
 * saem do MESMO cálculo nos dois lados. O gate mexe só na disponibilidade de `g`.
 *
 * Os helpers de negócio são IMPORTADOS de `src/` (código real de produção). O que está copiado
 * verbatim — `percentile`, `classifyHealth`, `clamp` e os laços da agenda — vive INLINE no hook
 * sem export; o wrapper `db/mede-impacto-gate-g.sh` tem assert de fidelidade contra o hook.
 *
 * Uso: bun scripts/impacto-gate-g.ts <dir-do-corpus> <saida.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accumulateMarginFromItems, resolveProductIdsFromItems } from '../src/lib/scoring/margin';
import { custoCanonico } from '../src/lib/custo/custoCanonico';
import { calcularHealthScore } from '../src/lib/scoring/healthScore';

// ─── CSV (RFC4180) — mesmo parser do harness de paridade ──────────────────────────────────────
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

const dir = process.argv[2];
const saida = process.argv[3];
if (!dir || !saida) {
  console.error('uso: bun scripts/impacto-gate-g.ts <dir-do-corpus> <saida.json>');
  process.exit(1);
}

const AGORA = Number(readFileSync(join(dir, 'agora.txt'), 'utf8').trim());
if (!Number.isFinite(AGORA)) throw new Error('agora.txt ilegível — o relógio do harness precisa ser fixo');

const cfg: Record<string, number> = {
  k1: 1.0, k2: 1.0, cat_target: 5,
  health_w_rf: 0.35, health_w_m: 0.20, health_w_g: 0.15, health_w_x: 0.15, health_w_s: 0.15,
  priority_w_churn: 0.40, priority_w_recover: 0.30, priority_w_expansion: 0.20, priority_w_eff: 0.10,
  agenda_pct_risco: 0.50, agenda_pct_expansao: 0.30, agenda_pct_followup: 0.20, sla_contact_days: 14,
};
for (const r of csv(dir, 'config.csv')) {
  const n = Number(r.value);
  if (Number.isFinite(n)) cfg[r.key] = n;
}

// ─── Corpus ───────────────────────────────────────────────────────────────────────────────────
const omieToProductId = new Map<number, string>();
for (const p of csv(dir, 'produtos.csv')) {
  if (p.omie_codigo_produto !== '') omieToProductId.set(Number(p.omie_codigo_produto), p.id);
}

const costMap = new Map<string, number>();
for (const pc of csv(dir, 'custos.csv')) {
  const c = custoCanonico({
    cost_final: pc.cost_final === '' ? null : pc.cost_final,
    cost_price: pc.cost_price === '' ? null : pc.cost_price,
  });
  if (c != null) costMap.set(pc.product_id, c);
}

const flaggeds = new Set(csv(dir, 'excluidos.csv').map((r) => r.user_id));
const profileMap = new Map<string, { name: string }>();
for (const p of csv(dir, 'profiles.csv')) profileMap.set(p.user_id, { name: p.name });

interface CustomerData {
  orderDates: number[];
  spend180d: number;
  categories: Set<string>;
}
const sixMonthsAgo = AGORA - 180 * 24 * 60 * 60 * 1000;
const sixtyDaysAgo = AGORA - 60 * 24 * 60 * 60 * 1000;

const customerMap = new Map<string, CustomerData>();
for (const order of csv(dir, 'pedidos.csv')) {
  const cid = order.customer_user_id;
  if (!cid) continue;
  if (flaggeds.has(cid)) continue;
  if (!customerMap.has(cid)) customerMap.set(cid, { orderDates: [], spend180d: 0, categories: new Set() });
  const cd = customerMap.get(cid)!;
  const orderTime = new Date(order.order_date_kpi !== '' ? order.order_date_kpi : order.created_at).getTime();
  cd.orderDates.push(orderTime);
  if (orderTime >= sixMonthsAgo) cd.spend180d += Number(order.total || 0);
  let items: unknown = [];
  try { items = JSON.parse(order.items || '[]'); } catch { items = []; }
  const arr = Array.isArray(items) ? items : [];
  // Mantido para paridade de custo de parsing com o hook; a margem aqui vem da RPC.
  void accumulateMarginFromItems(arr, costMap, omieToProductId);
  for (const pid of resolveProductIdsFromItems(arr, omieToProductId)) cd.categories.add(pid);
}

const callsPorFarmer = new Map<string, Record<string, string>[]>();
for (const c of csv(dir, 'calls.csv')) {
  if (!callsPorFarmer.has(c.farmer_id)) callsPorFarmer.set(c.farmer_id, []);
  callsPorFarmer.get(c.farmer_id)!.push(c);
}

// `g` como a RPC devolve (réplica verbatim extraída pelo wrapper).
const sqlPorCliente = new Map<string, { g: number | null; pct: number | null }>();
for (const r of csv(dir, 'sql-faixa.csv')) {
  sqlPorCliente.set(r.customer_user_id, {
    g: r.g === '' ? null : Number(r.g),
    pct: r.margem_pct === '' ? null : Number(r.margem_pct),
  });
}

const carteiraDe = new Map<string, Set<string>>();
for (const a of csv(dir, 'carteiras.csv')) {
  if (a.eligible !== 't' && a.eligible !== 'true') continue;
  if (!carteiraDe.has(a.owner_user_id)) carteiraDe.set(a.owner_user_id, new Set());
  carteiraDe.get(a.owner_user_id)!.add(a.customer_user_id);
}

interface Persona { id: string; rotulo: string; capTodo: boolean; capCusto: boolean }
const personas: Persona[] = JSON.parse(readFileSync(join(dir, 'personas-cap.json'), 'utf8'));

const allMonthlySpends: number[] = [];
customerMap.forEach((cd) => { allMonthlySpends.push(cd.spend180d / 6); });
const p95MonthlySpend = percentile(allMonthlySpends, 95) || 1;

interface Score {
  cid: string;
  churnRisk: number; expansionScore: number; priorityScore: number;
  healthAtual: number; healthGate: number;
  classeAtual: string; classeGate: string;
  g: number | null;
}

function pontuar(persona: Persona): Score[] {
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
    if (!profileMap.has(cid)) return; // VERBATIM: cliente sem profile não é pontuado

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

    // ESCOPO da RPC: fora da carteira → ausente do mapa → g null nos DOIS cenários.
    const noEscopo = persona.capTodo || visiveis.has(cid);
    const gAtual = (noEscopo ? sqlPorCliente.get(cid)?.g : undefined) ?? null;
    // O GATE: sem cap_custo_ler, `g` vira NULL — é a mudança que se está medindo.
    const gGate = persona.capCusto ? gAtual : null;

    const pesos = {
      rf: cfg.health_w_rf, m: cfg.health_w_m, g: cfg.health_w_g, x: cfg.health_w_x, s: cfg.health_w_s,
    };
    const healthAtual = calcularHealthScore({ rf, m, g: gAtual, x, s }, pesos);
    const healthGate = calcularHealthScore({ rf, m, g: gGate, x, s }, pesos);

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
      churnRisk: Math.round(churnRisk * 10) / 10,
      expansionScore: Math.round(expansionScore * 10) / 10,
      priorityScore: Math.round(priorityScore * 10) / 10,
      healthAtual: Math.round(healthAtual * 10) / 10,
      healthGate: Math.round(healthGate * 10) / 10,
      classeAtual: classifyHealth(healthAtual),
      classeGate: classifyHealth(healthGate),
      g: gAtual,
    });
  });

  scores.sort((a, b) => b.priorityScore - a.priorityScore);
  return scores;
}

// COPIA-INICIO agenda — verbatim dos 3 laços de src/hooks/useFarmerScoring.ts
function montarAgenda(scores: Score[]): string[] {
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
  return itens.map((i) => `${i.tipo}:${i.cid}`);
}
// COPIA-FIM agenda

const relatorio: Record<string, unknown> = {
  corpus: {
    pedidos: csv(dir, 'pedidos.csv').length,
    clientes_no_sql: sqlPorCliente.size,
    p95MonthlySpend,
  },
  personas: [],
};

for (const persona of personas) {
  const scores = pontuar(persona);

  // Só quem TEM `g` hoje pode perder — o resto é invariante por construção.
  const comG = scores.filter((s) => s.g != null);
  const mudouScore = scores.filter((s) => s.healthAtual !== s.healthGate);
  const mudouClasse = scores.filter((s) => s.classeAtual !== s.classeGate);

  const deltas = comG.map((s) => Math.abs(s.healthGate - s.healthAtual)).sort((a, b) => a - b);
  const media = deltas.reduce((a, b) => a + b, 0) / (deltas.length || 1);
  const p50 = deltas.length ? deltas[Math.floor(0.5 * (deltas.length - 1))] : 0;
  const p90 = deltas.length ? deltas[Math.floor(0.9 * (deltas.length - 1))] : 0;
  const maximo = deltas.length ? deltas[deltas.length - 1] : 0;
  const sobem = comG.filter((s) => s.healthGate > s.healthAtual).length;
  const descem = comG.filter((s) => s.healthGate < s.healthAtual).length;

  // A agenda é montada nos DOIS cenários: se alguma dimensão de prioridade lesse `g`, divergiria.
  const agendaAtual = montarAgenda(scores);
  const agendaGate = montarAgenda([...scores].sort((a, b) => b.priorityScore - a.priorityScore));
  const setAtual = new Set(agendaAtual.map((a) => a.split(':')[1]));
  const setGate = new Set(agendaGate.map((a) => a.split(':')[1]));
  const rotuloMudou = agendaAtual.filter((a) => {
    const s = scores.find((x) => x.cid === a.split(':')[1]);
    return s && s.classeAtual !== s.classeGate;
  }).length;

  const topDelta = [...comG]
    .map((s) => ({
      cid: s.cid,
      delta: +(s.healthGate - s.healthAtual).toFixed(2),
      g: s.g == null ? null : +s.g.toFixed(3),
      classeAtual: s.classeAtual, classeGate: s.classeGate,
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);

  (relatorio.personas as unknown[]).push({
    id: persona.id,
    rotulo: persona.rotulo,
    capTodo: persona.capTodo,
    capCusto: persona.capCusto,
    clientes: scores.length,
    clientes_com_g: comG.length,
    mudou_score: mudouScore.length,
    mudou_score_pct: comG.length ? +(100 * mudouScore.length / comG.length).toFixed(1) : 0,
    delta_medio: +media.toFixed(3),
    delta_p50: +p50.toFixed(3),
    delta_p90: +p90.toFixed(3),
    delta_max: +maximo.toFixed(3),
    sobem, descem,
    mudou_classe: mudouClasse.length,
    mudou_classe_pct: scores.length ? +(100 * mudouClasse.length / scores.length).toFixed(1) : 0,
    top_delta: topDelta,
    agenda_slots: agendaAtual.length,
    agenda_saiu: [...setAtual].filter((c) => !setGate.has(c)).length,
    agenda_entrou: [...setGate].filter((c) => !setAtual.has(c)).length,
    agenda_identica: agendaAtual.join('|') === agendaGate.join('|'),
    agenda_rotulo_mudou: rotuloMudou,
  });
}

writeFileSync(saida, JSON.stringify(relatorio, null, 2));
console.log(JSON.stringify(relatorio, null, 2));
