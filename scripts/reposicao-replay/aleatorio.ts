// Números aleatórios COMUNS do replay TSB (spec §5.9): hash estável da chave, sem `Math.random` e sem PRNG sequencial.
// `uniforme(...chave)` = FNV-1a 64 dos bytes UTF-8 da chave (partes separadas por \u0000) → finalizador splitmix64 → 53 bits
// altos / 2^53, em [0, 1). Mesma chave ⇒ mesmo número, em qualquer ordem de chamada (é isso que dá "aleatoriedade comum"
// entre fórmulas, β e replicações). Aritmética de 64 bits em pares de 32 bits (sem BigInt: o F2 chama isto dezenas de milhões
// de vezes). `ltRealizado` (Task 6) sorteia o LT por documento.
import { CHOQUE_LT_SEMANAS, JANELA_SORTEIO_LT_DU, JANELAS } from './config';
import type { Data, ItemLT } from './tipos';

const DOIS_32 = 4294967296;
const DOIS_53 = 9007199254740992;

/** Produto 32×32 → [alto, baixo] (64 bits exatos), via limbs de 16 bits. */
function mul32(a: number, b: number): [number, number] {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const t = a0 * b0;
  const m1 = a1 * b0;
  const m2 = a0 * b1;
  const meio = (t >>> 16) + (m1 & 0xffff) + (m2 & 0xffff);
  const baixo = (((meio & 0xffff) << 16) | (t & 0xffff)) >>> 0;
  const alto = (a1 * b1 + (m1 >>> 16) + (m2 >>> 16) + (meio >>> 16)) >>> 0;
  return [alto, baixo];
}

/** (ah:al) × (bh:bl) mod 2^64. */
function mul64(ah: number, al: number, bh: number, bl: number): [number, number] {
  const [h, l] = mul32(al, bl);
  return [(h + Math.imul(ah, bl) + Math.imul(al, bh)) >>> 0, l];
}

/** FNV-1a 64 sobre os bytes UTF-8 de `s`. Primo = 2^40 + 0x1b3; base = 0xcbf29ce484222325. */
export function fnv1a64(s: string): [number, number] {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  // ASCII (o caso do replay: códigos de SKU, datas, rótulos) dispensa o TextEncoder, que domina o custo.
  // eslint-disable-next-line no-control-regex
  const bytes: ArrayLike<number> = /^[\x00-\x7f]*$/.test(s) ? { length: s.length } : new TextEncoder().encode(s);
  const ascii = !(bytes instanceof Uint8Array);
  for (let i = 0; i < bytes.length; i++) {
    lo = (lo ^ (ascii ? s.charCodeAt(i) : bytes[i])) >>> 0;
    // h * 0x1b3 + (h << 40)
    const pl = lo * 0x1b3; // < 2^41: exato em double
    const carry = Math.floor(pl / DOIS_32);
    const novoLo = pl >>> 0;
    hi = (hi * 0x1b3 + carry + ((lo << 8) >>> 0)) >>> 0;
    lo = novoLo;
  }
  return [hi, lo];
}

/** Finalizador splitmix64 (z ^= z>>>30; z *= 0xbf58476d1ce4e5b9; z ^= z>>>27; z *= 0x94d049bb133111eb; z ^= z>>>31). */
export function splitmix64(hi: number, lo: number): [number, number] {
  let h = hi >>> 0;
  let l = lo >>> 0;
  // z ^= z >>> 30
  l = (l ^ ((l >>> 30) | (h << 2))) >>> 0;
  h = (h ^ (h >>> 30)) >>> 0;
  [h, l] = mul64(h, l, 0xbf58476d, 0x1ce4e5b9);
  // z ^= z >>> 27
  l = (l ^ ((l >>> 27) | (h << 5))) >>> 0;
  h = (h ^ (h >>> 27)) >>> 0;
  [h, l] = mul64(h, l, 0x94d049bb, 0x133111eb);
  // z ^= z >>> 31
  l = (l ^ ((l >>> 31) | (h << 1))) >>> 0;
  h = (h ^ (h >>> 31)) >>> 0;
  return [h, l];
}

/** Uniforme em [0, 1) determinística pela chave. Sem estado: independe da ordem de chamada. */
export function uniforme(...chave: (string | number)[]): number {
  const [h0, l0] = fnv1a64(chave.map(String).join('\u0000'));
  const [h, l] = splitmix64(h0, l0);
  return (h * 2097152 + (l >>> 11)) / DOIS_53; // 32 bits altos × 2^21 + 21 bits do baixo = 53 bits
}

/** Duas uniformes de 32 bits em [0, 1) da MESMA chave (metade alta e baixa do hash): metade do custo de 2 `uniforme`. */
export function uniformePar(...chave: (string | number)[]): [number, number] {
  const [h0, l0] = fnv1a64(chave.map(String).join('\u0000'));
  const [h, l] = splitmix64(h0, l0);
  return [h / DOIS_32, l / DOIS_32];
}

// ── Lead time realizado (spec §5.5 e §5.9 "Lead time — Sorteio") ──────────────────────────────────────────────────────
// Um DOCUMENTO é o par (t1, trackingId): no dado real 177 de 373 trackingIds têm itens com t1 diferentes (pedidos
// distintos consolidados no mesmo rastreio), e a ordem estável da spec é justamente (t1, tracking_id). Para o dia d e a
// replicação rep sorteia-se UM documento com t1 a ±10 du de d (sem candidato, a janela dobra até achar) por
// uniforme(rep,'doc',d) — o mesmo para todos os SKUs pedidos em d, preservando o choque comum do fornecedor —, e depois um
// item DESSE documento por uniforme(rep,'item',d,sku). Distância em du = |nº de dias úteis até t1 − até d| (seg–sex).
// O LT devolvido é o documental CRU (pode ser 0); o simulador impõe o mínimo efetivo de 1 du (chega no próximo du).

export type CenarioLT = 'empirico' | 'estresse15' | 'choque29';
const LT_ESTRESSE_DU = 15;
const LT_CHOQUE_DU = 29;

const DIA_MS = 86_400_000;
const SEGUNDA_EPOCA = Date.UTC(1970, 0, 5); // segunda-feira
/** Nº de dias úteis (seg–sex) de 1970-01-05 até d, inclusive. duEntre(a, b) = duAte(b) − duAte(a). */
export function duAte(d: Data): number {
  const dias = Math.round((Date.parse(`${d}T00:00:00Z`) - SEGUNDA_EPOCA) / DIA_MS);
  const semanas = Math.floor(dias / 7);
  const dow = dias - semanas * 7; // 0 = segunda
  return semanas * 5 + Math.min(dow + 1, 5);
}

interface DocLT {
  t1: Data;
  trackingId: string;
  duT1: number;
  /** Itens em ordem estável (sku, t4, ltDu). */
  lts: number[];
}
const docsMemo = new WeakMap<readonly ItemLT[], DocLT[]>();

function documentos(itens: readonly ItemLT[]): DocLT[] {
  const pronto = docsMemo.get(itens);
  if (pronto) return pronto;
  const porChave = new Map<string, { t1: Data; trackingId: string; itens: ItemLT[] }>();
  for (const it of itens) {
    const k = `${it.t1}\u0000${it.trackingId}`;
    const d = porChave.get(k);
    if (d) d.itens.push(it);
    else porChave.set(k, { t1: it.t1, trackingId: it.trackingId, itens: [it] });
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const docs = [...porChave.values()]
    .sort((a, b) => cmp(a.t1, b.t1) || cmp(a.trackingId, b.trackingId))
    .map((d) => ({
      t1: d.t1,
      trackingId: d.trackingId,
      duT1: duAte(d.t1),
      lts: d.itens.sort((a, b) => cmp(a.sku, b.sku) || cmp(a.t4 ?? '', b.t4 ?? '') || a.ltDu - b.ltDu).map((i) => i.ltDu),
    }));
  docsMemo.set(itens, docs);
  return docs;
}

/** Primeiro índice com duT1 >= alvo (docs ordenados por t1 ⇒ duT1 não decrescente). */
function primeiroDuT1(docs: DocLT[], alvo: number): number {
  let lo = 0;
  let hi = docs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (docs[m].duT1 < alvo) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** Documento sorteado para (rep, d): o mesmo para todos os SKUs. Exportado para teste e diagnóstico. */
export function documentoSorteado(rep: number, d: Data, itens: readonly ItemLT[]): { t1: Data; trackingId: string; lts: readonly number[] } {
  const docs = documentos(itens);
  if (docs.length === 0) throw new Error('LT_SEM_DOCUMENTOS');
  const c = duAte(d);
  const span = Math.max(Math.abs(c - docs[0].duT1), Math.abs(c - docs[docs.length - 1].duT1));
  for (let w = JANELA_SORTEIO_LT_DU; ; w *= 2) {
    const lo = primeiroDuT1(docs, c - w);
    const hi = primeiroDuT1(docs, c + w + 1); // exclusivo
    if (hi > lo) return docs[lo + Math.floor(uniforme(rep, 'doc', d) * (hi - lo))];
    if (w > span) throw new Error(`LT_SEM_CANDIDATO:${d}`); // inalcançável com docs não vazio; guarda de laço
  }
}

/** Semana (1 = a primeira) da avaliação que contém d; null antes dela. */
function semanaDaAvaliacao(d: Data): number | null {
  if (d < JANELAS.avaliacaoIni) return null;
  const dias = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${JANELAS.avaliacaoIni}T00:00:00Z`)) / DIA_MS);
  return Math.floor(dias / 7) + 1;
}

/**
 * LT (du) realizado do pedido do SKU feito em d na replicação rep. `itens` = amostra permitida no contexto
 * (calibração: `itensLtPermitidos(itens, true)`). estresse15 = max(LT, 15); choque29 = 29 nas semanas 9–12 da avaliação.
 */
export function ltRealizado(rep: number, d: Data, sku: string, cenario: CenarioLT, itens: readonly ItemLT[]): number {
  if (cenario === 'choque29') {
    const s = semanaDaAvaliacao(d);
    if (s !== null && s >= CHOQUE_LT_SEMANAS.de && s <= CHOQUE_LT_SEMANAS.ate) return LT_CHOQUE_DU;
  }
  const doc = documentoSorteado(rep, d, itens);
  const lt = doc.lts[Math.floor(uniforme(rep, 'item', d, sku) * doc.lts.length)];
  return cenario === 'estresse15' ? Math.max(lt, LT_ESTRESSE_DU) : lt;
}

/**
 * Amostra de LT permitida (spec §5.9 "Calibração"): na calibração só documentos com t4 (ou a data de extração, se
 * aberto) <= fim da calibração; na avaliação, todos.
 */
export function itensLtPermitidos(itens: readonly ItemLT[], calibracao: boolean, dataExtracao: Data): ItemLT[] {
  if (!calibracao) return [...itens];
  return itens.filter((i) => (i.aberto || i.t4 === null ? dataExtracao : i.t4) <= JANELAS.calibracaoFim);
}
