import { describe, it, expect } from 'vitest';
import { waPhoneCandidates } from './inbound';

describe('waPhoneCandidates', () => {
  it('normaliza E.164 do WhatsApp (móvel 13 dígitos) e gera variante sem o 9', () => {
    const c = waPhoneCandidates('5537998765432');
    expect(c).toContain('37998765432');
    expect(c).toContain('3798765432');
  });
  it('normaliza fixo (12 dígitos) sem inventar 9', () => {
    const c = waPhoneCandidates('553733334444');
    expect(c).toContain('3733334444');
    expect(c).not.toContain('37933334444');
  });
  it('aceita número já sem 55 e com máscara', () => {
    const c = waPhoneCandidates('(37) 99876-5432');
    expect(c).toContain('37998765432');
  });
  it('retorna vazio pra entrada inválida', () => {
    expect(waPhoneCandidates('')).toEqual([]);
    expect(waPhoneCandidates(null as unknown as string)).toEqual([]);
  });
});
