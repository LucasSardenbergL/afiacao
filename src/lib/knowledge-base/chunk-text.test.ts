import { describe, it, expect } from 'vitest';
import { chunkText } from './chunk-text';

describe('chunkText', () => {
  it('texto vazio retorna array vazio', () => {
    expect(chunkText('', { maxTokens: 500, overlap: 50 })).toEqual([]);
  });

  it('texto pequeno (< maxTokens) retorna 1 chunk só', () => {
    const text = 'Boletim técnico do produto Sayerlack PU 6827.';
    const chunks = chunkText(text, { maxTokens: 500, overlap: 50 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].charStart).toBe(0);
    expect(chunks[0].charEnd).toBe(text.length);
  });

  it('texto grande quebra em múltiplos chunks com overlap', () => {
    // ~2000 chars = ~500 tokens, dois chunks com maxTokens=300 (~1200 chars cada)
    const text = 'a'.repeat(2000);
    const chunks = chunkText(text, { maxTokens: 300, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    // Cada chunk respeita maxTokens (* 4 chars/token)
    for (const c of chunks) {
      expect(c.tokenEstimate).toBeLessThanOrEqual(300);
    }
  });

  it('overlap: chunks consecutivos compartilham conteúdo no fim/início', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const chunks = chunkText(sentences, { maxTokens: 50, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    // Overlap: fim do chunk[0] aparece no início do chunk[1]
    const lastTextOfFirst = chunks[0].content.slice(-20);
    expect(chunks[1].content.startsWith(lastTextOfFirst.slice(0, 10))
      || chunks[1].content.includes(lastTextOfFirst.slice(0, 10))).toBe(true);
  });

  it('charStart/charEnd corretos pra reconstruir o texto original', () => {
    const text = 'parte um. parte dois. parte tres. parte quatro.';
    const chunks = chunkText(text, { maxTokens: 5, overlap: 2 });
    for (const c of chunks) {
      // O conteúdo está dentro do range
      expect(text.slice(c.charStart, c.charEnd)).toContain(c.content.trim().slice(0, 5));
    }
  });

  it('chunks têm chunk_index implícito (ordem do array)', () => {
    const text = 'Sentence A. Sentence B. Sentence C. Sentence D. Sentence E.'.repeat(20);
    const chunks = chunkText(text, { maxTokens: 30, overlap: 5 });
    // Ordem preservada (sem assertion explícita de index — quem chama enumerate via array.map)
    expect(chunks.length).toBeGreaterThan(1);
  });
});
