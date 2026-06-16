import { describe, it, expect } from 'vitest';
import { chunkText } from '../chunk-text';

// CHARS_PER_TOKEN = 4 (interno). maxTokens=10 → maxChars=40; overlap=2 → overlapChars=8 → step=32.

describe('chunkText', () => {
  it('texto vazio → []', () => {
    expect(chunkText('', { maxTokens: 10, overlap: 2 })).toEqual([]);
  });

  it('texto ≤ maxChars → 1 chunk cobrindo tudo, tokenEstimate = ceil(len/4)', () => {
    const text = 'x'.repeat(30); // ≤ 40
    const r = chunkText(text, { maxTokens: 10, overlap: 2 });
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({ content: text, charStart: 0, charEnd: 30, tokenEstimate: Math.ceil(30 / 4) });
  });

  it('boundary: len === maxChars → ainda 1 chunk', () => {
    const text = 'x'.repeat(40);
    const r = chunkText(text, { maxTokens: 10, overlap: 2 });
    expect(r).toHaveLength(1);
    expect(r[0].charEnd).toBe(40);
  });

  it('texto longo → múltiplos chunks com overlap = overlapChars', () => {
    const text = 'x'.repeat(100);
    const r = chunkText(text, { maxTokens: 10, overlap: 2 }); // maxChars 40, step 32
    expect(r.map((c) => [c.charStart, c.charEnd])).toEqual([
      [0, 40],
      [32, 72],
      [64, 100],
    ]);
    // overlap entre consecutivos = 8 chars (overlapChars)
    expect(r[0].charEnd - r[1].charStart).toBe(8);
    expect(r[1].charEnd - r[2].charStart).toBe(8);
    // último chunk encerra exatamente no fim
    expect(r[r.length - 1].charEnd).toBe(100);
    // content sempre = slice(charStart,charEnd)
    for (const c of r) expect(c.content).toBe(text.slice(c.charStart, c.charEnd));
  });

  it('overlap 0 → chunks contíguos (sem sobreposição)', () => {
    const text = 'x'.repeat(100);
    const r = chunkText(text, { maxTokens: 10, overlap: 0 }); // step = maxChars = 40
    expect(r.map((c) => [c.charStart, c.charEnd])).toEqual([
      [0, 40],
      [40, 80],
      [80, 100],
    ]);
  });

  it('overlap ≥ maxTokens (step degenerado) → não entra em loop infinito (step piso 1)', () => {
    const text = 'x'.repeat(50);
    const r = chunkText(text, { maxTokens: 10, overlap: 10 }); // overlapChars 40 ≥ maxChars 40 → step max(1,0)=1
    expect(r.length).toBeGreaterThan(0);
    expect(r.length).toBeLessThan(text.length); // finito
    expect(r[r.length - 1].charEnd).toBe(50); // cobre até o fim
  });
});
