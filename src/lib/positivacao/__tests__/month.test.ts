import { describe, it, expect } from 'vitest';
import { mesComercialCorrente } from '../month';

describe('mesComercialCorrente (MTD, America/Sao_Paulo)', () => {
  it('retorna 1º dia do mês e 1º dia do mês seguinte (datas ISO yyyy-mm-dd)', () => {
    // 2026-05-15T12:00:00Z → ainda 15/mai em BRT
    const r = mesComercialCorrente(new Date('2026-05-15T12:00:00Z'));
    expect(r.inicioIso).toBe('2026-05-01');
    expect(r.fimIso).toBe('2026-06-01');
  });

  it('vira o mês corretamente perto da meia-noite UTC (offset BRT -3)', () => {
    // 2026-06-01T02:00:00Z = 31/mai 23:00 BRT → ainda mês de maio
    const r = mesComercialCorrente(new Date('2026-06-01T02:00:00Z'));
    expect(r.inicioIso).toBe('2026-05-01');
    expect(r.fimIso).toBe('2026-06-01');
  });

  it('vira o ano em dezembro', () => {
    // 2026-12-10 → dez/2026, fim = jan/2027
    const r = mesComercialCorrente(new Date('2026-12-10T12:00:00Z'));
    expect(r.inicioIso).toBe('2026-12-01');
    expect(r.fimIso).toBe('2027-01-01');
  });
});
