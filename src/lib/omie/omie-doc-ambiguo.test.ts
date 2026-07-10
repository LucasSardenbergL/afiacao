import { describe, it, expect } from 'vitest';
import { docsComCodigoAmbiguoNoOmie } from './omie-doc-ambiguo';

// P1b (fail-closed no doc-dup-Omie) — espelha o fail-closed do lado profile (fetchProfileDocUserMap).
// Falsificação: os casos +/- se falsificam MUTUAMENTE — um helper que retorna sempre-∅ reprova o caso
// ambíguo; um que marca tudo reprova os casos não-ambíguos. Ver
// docs/superpowers/specs/2026-07-09-omie-proof-table-staleness-doc-ambiguo-design.md
describe('docsComCodigoAmbiguoNoOmie (P1b fail-closed money-path)', () => {
  it('doc com 1 só código → NÃO ambíguo (∅)', () => {
    const r = docsComCodigoAmbiguoNoOmie([{ doc: '111', codigo: 100 }]);
    expect(r.size).toBe(0);
  });

  it('doc com 2 códigos DISTINTOS na mesma conta → AMBÍGUO (fecha o last-write-wins)', () => {
    const r = docsComCodigoAmbiguoNoOmie([
      { doc: '111', codigo: 100 },
      { doc: '111', codigo: 200 },
    ]);
    expect(r.has('111')).toBe(true);
    expect(r.size).toBe(1);
  });

  it('doc com o MESMO código repetido (duplicata do Omie na paginação) → NÃO ambíguo', () => {
    const r = docsComCodigoAmbiguoNoOmie([
      { doc: '111', codigo: 100 },
      { doc: '111', codigo: 100 },
    ]);
    expect(r.size).toBe(0);
  });

  it('3+ códigos no mesmo doc → ambíguo', () => {
    const r = docsComCodigoAmbiguoNoOmie([
      { doc: '111', codigo: 100 },
      { doc: '111', codigo: 200 },
      { doc: '111', codigo: 300 },
    ]);
    expect(r.has('111')).toBe(true);
  });

  it('doc vazio é ignorado (não vira chave)', () => {
    const r = docsComCodigoAmbiguoNoOmie([
      { doc: '', codigo: 100 },
      { doc: '', codigo: 200 },
    ]);
    expect(r.size).toBe(0);
  });

  it('mistura: só os docs ambíguos entram; os limpos ficam de fora (precisão do escopo)', () => {
    const r = docsComCodigoAmbiguoNoOmie([
      { doc: 'A', codigo: 1 }, // limpo
      { doc: 'B', codigo: 2 }, // ambíguo (2 códigos)
      { doc: 'B', codigo: 3 },
      { doc: 'C', codigo: 4 }, // limpo
      { doc: 'C', codigo: 4 }, // repetição do mesmo → segue limpo
    ]);
    expect([...r].sort()).toEqual(['B']);
  });

  it('lista vazia → ∅', () => {
    expect(docsComCodigoAmbiguoNoOmie([]).size).toBe(0);
  });
});
