import { describe, it, expect } from 'vitest';
import { deriveVisitaStatus } from '../visita-status';

describe('deriveVisitaStatus', () => {
  const hoje = '2026-05-30';
  it('realizada/cancelada passam direto', () => {
    expect(deriveVisitaStatus('2026-05-01', 'realizada', hoje)).toBe('realizada');
    expect(deriveVisitaStatus('2026-06-10', 'cancelada', hoje)).toBe('cancelada');
  });
  it('pendente no passado → atrasada', () => {
    expect(deriveVisitaStatus('2026-05-29', 'pendente', hoje)).toBe('atrasada');
  });
  it('pendente hoje → hoje', () => {
    expect(deriveVisitaStatus('2026-05-30', 'pendente', hoje)).toBe('hoje');
  });
  it('pendente no futuro → futura', () => {
    expect(deriveVisitaStatus('2026-06-01', 'pendente', hoje)).toBe('futura');
  });
});
