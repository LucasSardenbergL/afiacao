import { describe, it, expect } from 'vitest';
import { hojeSP, addDias, inicioMes, spMeiaNoiteUTC, periodoMesAnterior } from '../sp-date';

describe('sp-date', () => {
  it('addDias atravessa fronteira de mês/ano', () => {
    expect(addDias('2026-06-30', 1)).toBe('2026-07-01');
    expect(addDias('2026-06-04', -6)).toBe('2026-05-29');
    expect(addDias('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDias('2026-06-04', 0)).toBe('2026-06-04');
  });

  it('inicioMes → primeiro dia do mês', () => {
    expect(inicioMes('2026-06-15')).toBe('2026-06-01');
    expect(inicioMes('2026-12-31')).toBe('2026-12-01');
  });

  it('spMeiaNoiteUTC → T03:00Z (SP = UTC−3 fixo)', () => {
    expect(spMeiaNoiteUTC('2026-06-04')).toBe('2026-06-04T03:00:00.000Z');
  });

  it('hojeSP → string YYYY-MM-DD', () => {
    expect(hojeSP()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('periodoMesAnterior: mesmo período do mês passado (capado no tamanho do mês)', () => {
    expect(periodoMesAnterior('2026-06-04')).toEqual({ de: '2026-05-01', ate: '2026-05-05' });
    expect(periodoMesAnterior('2026-01-15')).toEqual({ de: '2025-12-01', ate: '2025-12-16' }); // vira ano
    expect(periodoMesAnterior('2026-03-31')).toEqual({ de: '2026-02-01', ate: '2026-03-01' }); // fev tem 28
  });
});
