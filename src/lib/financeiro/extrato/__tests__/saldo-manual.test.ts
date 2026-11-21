import { describe, expect, it } from 'vitest';
import { hojeSaoPaulo, saldoBrParaCentavos, validarAncora } from '../saldo-manual';

describe('saldoBrParaCentavos', () => {
  it.each([
    ['12.345,67', 1234567],
    ['-12.345,67', -1234567],
    ['0,00', 0],
    ['-0,00', 0],
    ['1234,5', 123450],
    ['100', 10000],
    ['  -1.000,00 ', -100000],
  ])('%s -> %i', (txt, c) => {
    expect(saldoBrParaCentavos(txt)).toBe(c);
  });
  it.each(['', '  ', '-', 'abc', '12.345', '1,2,3', '12,345', '1.23.456,00'])('%j é recusado (null), nunca 0', (txt) => {
    expect(saldoBrParaCentavos(txt)).toBeNull();
  });
  it('não usa ponto flutuante: 0,10 + valores grandes saem exatos', () => {
    expect(saldoBrParaCentavos('0,10')).toBe(10);
    expect(saldoBrParaCentavos('90.071.992.547.409,92')).toBeNull(); // acima de MAX_SAFE_INTEGER centavos
  });
});

describe('validarAncora', () => {
  it('aceita dia fechado + saldo inequívoco', () => {
    expect(validarAncora({ data: '2026-11-19', saldo: '1.500,00' }, '2026-11-21')).toEqual({ ok: true, data: '2026-11-19', centavos: 150000 });
  });
  it('recusa hoje, futuro e data inválida', () => {
    expect(validarAncora({ data: '2026-11-21', saldo: '1,00' }, '2026-11-21')).toMatchObject({ ok: false, erros: { data: expect.any(String) } });
    expect(validarAncora({ data: '2026-11-30', saldo: '1,00' }, '2026-11-21')).toMatchObject({ ok: false });
    expect(validarAncora({ data: '2026-02-31', saldo: '1,00' }, '2026-11-21')).toMatchObject({ ok: false });
    expect(validarAncora({ data: '', saldo: '1,00' }, '2026-11-21')).toMatchObject({ ok: false });
  });
  it('recusa saldo ambíguo', () => {
    expect(validarAncora({ data: '2026-11-19', saldo: '12.345' }, '2026-11-21')).toMatchObject({ ok: false, erros: { saldo: expect.any(String) } });
  });
});

describe('hojeSaoPaulo', () => {
  it('usa o fuso de São Paulo (02:00Z do dia 21 ainda é dia 20)', () => {
    expect(hojeSaoPaulo(new Date('2026-11-21T02:00:00Z'))).toBe('2026-11-20');
    expect(hojeSaoPaulo(new Date('2026-11-21T12:00:00Z'))).toBe('2026-11-21');
  });
});
