import { describe, it, expect } from 'vitest';
import { statusCron, statusSync, statusCoverage, nivelAgregado } from '../status';

describe('statusCron', () => {
  it('nunca rodou → yellow', () => {
    expect(statusCron({ last_status: null, age_hours: null }, 48).nivel).toBe('yellow');
  });
  it('última falhou → red', () => {
    expect(statusCron({ last_status: 'failed', age_hours: 1 }, 48).nivel).toBe('red');
    expect(statusCron({ last_status: 'failure', age_hours: 1 }, 48).nivel).toBe('red');
  });
  it('atrasado além do maxAge → red', () => {
    expect(statusCron({ last_status: 'succeeded', age_hours: 60 }, 48).nivel).toBe('red');
  });
  it('sucesso recente → green', () => {
    expect(statusCron({ last_status: 'succeeded', age_hours: 10 }, 48).nivel).toBe('green');
  });
  it('maxAge null (mensal) não alerta por idade → green', () => {
    expect(statusCron({ last_status: 'succeeded', age_hours: 600 }, null).nivel).toBe('green');
  });
});

describe('statusSync', () => {
  it('sem sync → yellow', () => {
    expect(statusSync({ age_hours: null, stale_count: 0 }).nivel).toBe('yellow');
  });
  it('>48h → red', () => {
    expect(statusSync({ age_hours: 50, stale_count: 0 }).nivel).toBe('red');
  });
  it('stale_count > 0 → red', () => {
    expect(statusSync({ age_hours: 2, stale_count: 5 }).nivel).toBe('red');
  });
  it('24-48h → yellow', () => {
    expect(statusSync({ age_hours: 30, stale_count: 0 }).nivel).toBe('yellow');
  });
  it('<24h → green', () => {
    expect(statusSync({ age_hours: 5, stale_count: 0 }).nivel).toBe('green');
  });
});

describe('statusCoverage', () => {
  it('carteira vazia → yellow', () => {
    expect(statusCoverage({ carteira: 0, fcs_clientes: 0, cvs_clientes: 0 }).nivel).toBe('yellow');
  });
  it('mismatch → red', () => {
    expect(statusCoverage({ carteira: 6908, fcs_clientes: 6900, cvs_clientes: 6908 }).nivel).toBe('red');
  });
  it('cobertura completa → green', () => {
    expect(statusCoverage({ carteira: 6908, fcs_clientes: 6908, cvs_clientes: 6908 }).nivel).toBe('green');
  });
});

describe('nivelAgregado', () => {
  it('red ganha', () => {
    expect(nivelAgregado(['green', 'yellow', 'red'])).toBe('red');
  });
  it('yellow sobre green', () => {
    expect(nivelAgregado(['green', 'yellow', 'green'])).toBe('yellow');
  });
  it('tudo green → green', () => {
    expect(nivelAgregado(['green', 'green'])).toBe('green');
  });
});
