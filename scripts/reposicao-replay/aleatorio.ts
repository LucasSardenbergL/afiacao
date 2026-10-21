// Números aleatórios COMUNS do replay TSB (spec §5.9): hash estável da chave, sem `Math.random` e sem PRNG sequencial.
// `uniforme(...chave)` = FNV-1a 64 dos bytes UTF-8 da chave (partes separadas por \u0000) → finalizador splitmix64 → 53 bits
// altos / 2^53, em [0, 1). Mesma chave ⇒ mesmo número, em qualquer ordem de chamada (é isso que dá "aleatoriedade comum"
// entre fórmulas, β e replicações). Aritmética de 64 bits em pares de 32 bits (sem BigInt: o F2 chama isto dezenas de milhões
// de vezes). A Task 6 completa este módulo com `ltRealizado`.

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
