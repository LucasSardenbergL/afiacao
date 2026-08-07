import { describe, it, expect } from 'vitest';
import { insumosAusentesVencedora } from '../useMyVisitSuggestions';

describe('insumosAusentesVencedora', () => {
  it('lê os insumos ausentes gravados pela edge em score_breakdown.insumos_ausentes', () => {
    expect(
      insumosAusentesVencedora({ insumos_ausentes: ['recover_score'] }),
    ).toEqual(['recover_score']);
  });

  it('linha antiga sem a chave (calculada antes deste campo nascer) degrada para []', () => {
    expect(insumosAusentesVencedora({ mission_scores: {} })).toEqual([]);
  });

  it('score_breakdown null degrada para [], nunca lança', () => {
    expect(insumosAusentesVencedora(null)).toEqual([]);
  });

  it('formato inesperado (não-array) degrada para [] em vez de fabricar "medida por completo"', () => {
    expect(insumosAusentesVencedora({ insumos_ausentes: 'recover_score' })).toEqual([]);
  });
});
