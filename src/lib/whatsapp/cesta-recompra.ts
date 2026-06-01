// Montador da cesta de recompra (accept-a-proposal). PURO/testável.
// Metodologia revisada adversarialmente com codex (2026-05-31). O helper EMITE CANDIDATOS +
// confiança; a validação de SKU ativo / preço firme / estoque é no ENVIO (Omie), nunca aqui
// (regra "a IA nunca inventa preço/SKU"). ultimoPrecoRef é só debug — nunca vai na mensagem.

export interface PedidoLine {
  omie_codigo_produto: number;
  quantity: number;
  unit_price: number;
  order_date: string; // 'YYYY-MM-DD' (order_date_kpi — dia canônico)
  account: string;
  status: string;
}
export interface CestaOpts {
  account: string;            // particiona por conta (codex P1: mesmo cliente em contas ≠ mistura padrão)
  hoje: string;               // 'YYYY-MM-DD'
  statusValidos: string[];    // whitelist EXPLÍCITA de status comerciais (codex P1)
  janelaDias?: number;        // default 180
  capPrincipal?: number;      // default 8
  fracaoMinima?: number;      // default 0.20
  dueRatioPrincipal?: number; // default 0.70
  frequenteFrac?: number;     // default 0.50
}
export type Confianca = 'alta' | 'media' | 'baixa';
export interface CestaItem {
  omie_codigo_produto: number;
  qtdSugerida: number;
  dueRatio: number;
  nPedidos: number;
  cadenciaDias: number | null;
  confidence: Confianca;
  motivo: 'recorrente_due' | 'frequente' | 'secundario';
  ultimoPrecoRef: number; // SÓ observabilidade/debug — não usar em mensagem nem decisão
}
export interface CestaResult {
  principal: CestaItem[];
  secundarios: CestaItem[];
  totalPedidos: number;
  confianca: Confianca;
}

const DUE_RECORRENCIA = 0.8;   // dueRatio que dispensa a fração mínima na recorrência
const STALE_FLOOR_DIAS = 90;   // piso absoluto de stale (codex Q4: cadência fraca não confiável)
const STALE_MULT = 2.5;

export function mediana(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Mediana com ajuste de tendência: cliente em crescimento (últimas compras subindo) puxa pra cima. */
export function medianaComTendencia(qtys: number[]): number {
  const base = mediana(qtys);
  if (qtys.length >= 2) {
    const ult = qtys.slice(-3);
    const crescente = ult.every((v, i) => i === 0 || v > ult[i - 1]);
    const ultimaQtd = qtys[qtys.length - 1];
    if (crescente && ultimaQtd >= 1.3 * base) return mediana(ult);
  }
  return base;
}

function diffDaysIso(from: string, to: string): number {
  return Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86_400_000);
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

interface Cand extends CestaItem { layer: 'principal' | 'secundario' }

export function montarCestaRecompra(lines: PedidoLine[], opts: CestaOpts): CestaResult {
  const janela = opts.janelaDias ?? 180;
  const cap = opts.capPrincipal ?? 8;
  const fracMin = opts.fracaoMinima ?? 0.20;
  const dueP = opts.dueRatioPrincipal ?? 0.70;
  const freqF = opts.frequenteFrac ?? 0.50;
  const cutoff = addDays(opts.hoje, -janela);

  // filtro: conta + whitelist de status + janela (compare ISO lexicográfico p/ 'YYYY-MM-DD')
  const valid = lines.filter(l =>
    l.account === opts.account && opts.statusValidos.includes(l.status) && l.order_date >= cutoff);

  const totalPedidos = new Set(valid.map(l => l.order_date)).size;
  if (totalPedidos < 2) return { principal: [], secundarios: [], totalPedidos, confianca: 'baixa' };

  const bySku = new Map<number, PedidoLine[]>();
  for (const l of valid) {
    const arr = bySku.get(l.omie_codigo_produto);
    if (arr) arr.push(l); else bySku.set(l.omie_codigo_produto, [l]);
  }

  const cands: Cand[] = [];
  for (const [sku, slines] of bySku) {
    // agrega por DIA canônico (codex P2: 2 pedidos no mesmo dia = 1 compra)
    const qtyPorDia = new Map<string, number>();
    for (const l of slines) qtyPorDia.set(l.order_date, (qtyPorDia.get(l.order_date) ?? 0) + l.quantity);
    const datas = [...qtyPorDia.keys()].sort();
    const nPedidos = datas.length;
    if (nPedidos < 2) continue; // piso de recorrência

    const qtysPorDia = datas.map(d => qtyPorDia.get(d) as number);
    const intervals: number[] = [];
    for (let i = 1; i < datas.length; i++) intervals.push(diffDaysIso(datas[i - 1], datas[i]));
    const cadenciaDias = mediana(intervals);
    const lastDate = datas[datas.length - 1];
    const diasDesdeUltima = diffDaysIso(lastDate, opts.hoje);
    const dueRatio = cadenciaDias > 0 ? diasDesdeUltima / cadenciaDias : diasDesdeUltima;
    const fracPedidos = nPedidos / totalPedidos;

    // recorrência: ≥2 (já garantido) E (fração mínima OU já due)
    if (!(fracPedidos >= fracMin || dueRatio >= DUE_RECORRENCIA)) continue;
    // stale: não comprado há mais que max(2.5×cadência, 90d)
    if (diasDesdeUltima > Math.max(STALE_MULT * cadenciaDias, STALE_FLOOR_DIAS)) continue;

    const qtdSugerida = medianaComTendencia(qtysPorDia);
    const fracionada = !Number.isInteger(qtdSugerida) || qtysPorDia.some(q => !Number.isInteger(q));

    let confidence: Confianca = 'media';
    if (nPedidos >= 4) confidence = 'alta';
    if (nPedidos < 3) confidence = 'baixa';
    if (fracionada) confidence = 'baixa';

    const ultimoPrecoRef = slines.filter(l => l.order_date === lastDate).pop()?.unit_price ?? 0;

    const isDue = dueRatio >= dueP;
    const isFreq = fracPedidos >= freqF;
    const layer: 'principal' | 'secundario' = (isDue || isFreq) ? 'principal' : 'secundario';
    const motivo: CestaItem['motivo'] = layer === 'secundario' ? 'secundario' : (isDue ? 'recorrente_due' : 'frequente');

    cands.push({ omie_codigo_produto: sku, qtdSugerida, dueRatio, nPedidos, cadenciaDias, confidence, motivo, ultimoPrecoRef, layer });
  }

  const byDueDesc = (a: Cand, b: Cand) => b.dueRatio - a.dueRatio;
  const principalCands = cands.filter(c => c.layer === 'principal').sort(byDueDesc);
  const secundariosCands = cands.filter(c => c.layer === 'secundario').sort(byDueDesc);
  const principal = principalCands.slice(0, cap);
  const overflow = principalCands.slice(cap); // estourou o cap → vira "também costuma levar"
  const secundarios = [...overflow, ...secundariosCands].sort(byDueDesc);

  const strip = (c: Cand): CestaItem => {
    const { layer: _layer, ...item } = c;
    return item;
  };

  let confianca: Confianca = 'alta';
  if (totalPedidos < 6) confianca = 'media';
  if (totalPedidos < 3) confianca = 'baixa';

  return { principal: principal.map(strip), secundarios: secundarios.map(strip), totalPedidos, confianca };
}
