import { describe, it, expect } from 'vitest';
import {
  fmt, fmtCompact, fmtDate, statusColor, getWeekLabel, formatCnpj,
} from '../format';

describe('fmt', () => {
  it('formata em BRL com 2 casas', () => {
    const out = fmt(1234.5);
    expect(out).toContain('R$');
    expect(out).toMatch(/1\.234,50/);
  });
  it('zero', () => {
    expect(fmt(0)).toMatch(/0,00/);
  });
});

describe('fmtCompact', () => {
  it('milhões → M com 1 casa', () => {
    expect(fmtCompact(1_500_000)).toBe('R$ 1.5M');
  });
  it('milhares → k com 1 casa', () => {
    expect(fmtCompact(2_300)).toBe('R$ 2.3k');
  });
  it('abaixo de mil cai no fmt completo', () => {
    expect(fmtCompact(500)).toMatch(/500,00/);
  });
  it('negativos usam |v| para escolher a faixa', () => {
    expect(fmtCompact(-2_000_000)).toBe('R$ -2.0M');
  });
});

describe('fmtDate', () => {
  it('null → travessão', () => {
    expect(fmtDate(null)).toBe('—');
  });
  it('ISO date → dd/mm/aaaa pt-BR', () => {
    expect(fmtDate('2026-04-15')).toBe('15/04/2026');
  });
});

describe('statusColor', () => {
  it('estados liquidados → success', () => {
    expect(statusColor('PAGO')).toBe('bg-status-success-bg text-status-success');
    expect(statusColor('RECEBIDO')).toBe('bg-status-success-bg text-status-success');
    expect(statusColor('LIQUIDADO')).toBe('bg-status-success-bg text-status-success');
  });
  it('VENCIDO → error, PARCIAL → warning, CANCELADO → cinza', () => {
    expect(statusColor('VENCIDO')).toBe('bg-status-error-bg text-status-error');
    expect(statusColor('PARCIAL')).toBe('bg-status-warning-bg text-status-warning');
    expect(statusColor('CANCELADO')).toBe('bg-gray-100 text-gray-500');
  });
  it('desconhecido → info (default)', () => {
    expect(statusColor('QUALQUER')).toBe('bg-status-info-bg text-status-info');
  });
});

describe('getWeekLabel', () => {
  it('formato DD/MM', () => {
    expect(getWeekLabel(new Date('2026-01-07T00:00:00'))).toMatch(/^\d{2}\/\d{2}$/);
  });
  it('dias da mesma semana (dom-sáb) caem no mesmo rótulo (início de semana)', () => {
    // 2026-01-04 é domingo; 05 (seg) e 10 (sáb) caem na mesma semana
    const seg = getWeekLabel(new Date('2026-01-05T00:00:00'));
    const sab = getWeekLabel(new Date('2026-01-10T00:00:00'));
    expect(seg).toBe(sab);
    expect(seg).toBe('04/01');
  });
});

describe('formatCnpj', () => {
  it('14 dígitos → CNPJ mascarado', () => {
    expect(formatCnpj('12345678000190')).toBe('12.345.678/0001-90');
  });
  it('11 dígitos → CPF mascarado', () => {
    expect(formatCnpj('12345678901')).toBe('123.456.789-01');
  });
  it('comprimento inesperado → retorna sem máscara', () => {
    expect(formatCnpj('123')).toBe('123');
  });
});
