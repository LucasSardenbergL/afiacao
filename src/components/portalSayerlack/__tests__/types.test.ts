import { describe, it, expect } from 'vitest';
import { fmtBRL, fmtDate, fmtDateTime, relTime, SAYERLACK_FILTER, PEDIDO_COLS } from '../types';

describe('fmtBRL', () => {
  it('formata moeda e — para null/undefined', () => {
    expect(fmtBRL(null)).toBe('—');
    expect(fmtBRL(undefined)).toBe('—');
    expect(fmtBRL(1234.5)).toContain('1.234,50');
    expect(fmtBRL(1234.5)).toContain('R$');
  });
});

describe('fmtDate / fmtDateTime', () => {
  it('— para vazio e data válida com barras', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDateTime(undefined)).toBe('—');
    expect(fmtDate('2026-01-15T10:00:00')).toContain('/');
  });
});

describe('relTime', () => {
  it('— para null', () => {
    expect(relTime(null)).toBe('—');
  });
  it('passado em minutos/horas/dias', () => {
    expect(relTime(new Date(Date.now() - 5 * 60000).toISOString())).toBe('há 5m');
    expect(relTime(new Date(Date.now() - 2 * 3600000).toISOString())).toBe('há 2h');
    expect(relTime(new Date(Date.now() - 3 * 86400000).toISOString())).toBe('há 3d');
  });
  it('futuro em minutos', () => {
    expect(relTime(new Date(Date.now() + 10 * 60000).toISOString())).toBe('em 10m');
  });
});

describe('constantes', () => {
  it('SAYERLACK_FILTER e PEDIDO_COLS', () => {
    expect(SAYERLACK_FILTER.empresa).toBe('OBEN');
    expect(SAYERLACK_FILTER.fornecedorIlike).toBe('%SAYERLACK%');
    expect(PEDIDO_COLS).toContain('status_envio_portal');
    expect(PEDIDO_COLS).toContain('portal_protocolo');
  });
});
