import { describe, it, expect } from 'vitest';
import { nextOptInStatus } from './opt-in';

describe('nextOptInStatus', () => {
  it('primeira resposta (unknown) → opt_in (consentimento)', () => {
    expect(nextOptInStatus('unknown', 'oi, quanto custa?')).toBe('opt_in');
  });
  it('PARAR → opt_out, mesmo se estava opt_in', () => {
    expect(nextOptInStatus('opt_in', 'PARAR')).toBe('opt_out');
    expect(nextOptInStatus('unknown', 'parar')).toBe('opt_out');
  });
  it('opt_out é sticky (mensagem comum não reverte)', () => {
    expect(nextOptInStatus('opt_out', 'oi de novo')).toBe('opt_out');
  });
  it('opt_in continua opt_in', () => {
    expect(nextOptInStatus('opt_in', 'mais uma pergunta')).toBe('opt_in');
  });
  it('inbound sem texto (áudio/imagem) ainda é engajamento → opt_in se unknown', () => {
    expect(nextOptInStatus('unknown', null)).toBe('opt_in');
  });
  it('status vazio tratado como unknown', () => {
    expect(nextOptInStatus('', 'oi')).toBe('opt_in');
  });
});
