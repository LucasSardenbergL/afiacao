import { describe, it, expect } from 'vitest';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { ehDataPuraUtc, formatarDataPedido } from '../data-pedido';

describe('formatarDataPedido', () => {
  it('data-pura do sync (meia-noite UTC) → só a data, no dia UTC correto (não escorrega pro dia anterior)', () => {
    // omie-vendas-sync grava data_previsao "10/06/2026" como new Date('2026-06-10') = 00:00 UTC.
    // Formatar no fuso local (BRT, UTC-3) mostraria "09/06/2026 às 21:00" — hora fabricada + dia errado.
    expect(formatarDataPedido('2026-06-10T00:00:00+00:00')).toBe('10/06/2026');
    expect(formatarDataPedido('2026-06-10T00:00:00.000Z')).toBe('10/06/2026');
  });

  it('data-pura do sync de recência (meio-dia UTC) → só a data (20260624170000: created_at = order_date_kpi às 12:00Z)', () => {
    // O fix de recência grava created_at = MEIO-DIA UTC (timezone-safe). Sem reconhecê-lo como
    // data-pura, o card exibiria "10/06/2026 às 09:00" (09:00 BRT = 12:00 UTC) — hora fabricada.
    expect(formatarDataPedido('2026-06-10T12:00:00.000Z')).toBe('10/06/2026');
    expect(formatarDataPedido('2026-06-10T12:00:00.000Z', 'dd/MM/yyyy HH:mm')).toBe('10/06/2026');
  });

  it('timestamp com hora real (pedido do wizard) → data + hora local, comportamento atual preservado', () => {
    const iso = '2026-06-09T17:32:45.123Z';
    const esperado = format(new Date(iso), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
    expect(formatarDataPedido(iso)).toBe(esperado);
    expect(formatarDataPedido(iso)).toContain(' às ');
  });

  it('meia-noite com offset local (não-UTC) tem hora real → mantém hora', () => {
    // 00:00 -03:00 = 03:00 UTC — não é o padrão do sync, é um instante real.
    expect(formatarDataPedido('2026-06-10T00:00:00-03:00')).toContain(' às ');
  });

  it('milissegundo ≠ 0 à meia-noite UTC não é data-pura → mantém hora', () => {
    expect(formatarDataPedido('2026-06-10T00:00:00.500Z')).toContain(' às ');
  });

  it('entrada inválida → "—" (nunca quebra o card)', () => {
    expect(formatarDataPedido('lixo')).toBe('—');
    expect(formatarDataPedido('')).toBe('—');
  });

  it('formato com-hora customizável (cupom de impressão usa "dd/MM/yyyy HH:mm", sem o "às")', () => {
    const iso = '2026-06-09T17:32:45.123Z';
    const esperado = format(new Date(iso), 'dd/MM/yyyy HH:mm', { locale: ptBR });
    expect(formatarDataPedido(iso, 'dd/MM/yyyy HH:mm')).toBe(esperado);
    // data-pura ignora o formato com-hora: sai só a data UTC
    expect(formatarDataPedido('2026-06-10T00:00:00Z', 'dd/MM/yyyy HH:mm')).toBe('10/06/2026');
  });
});

describe('ehDataPuraUtc', () => {
  it('detecta meia-noite E meio-dia UTC exatos (data-pura do Omie); rejeita outras horas/ms', () => {
    expect(ehDataPuraUtc(new Date('2026-06-10T00:00:00.000Z'))).toBe(true); // legado (data_previsao)
    expect(ehDataPuraUtc(new Date('2026-06-10T12:00:00.000Z'))).toBe(true); // recência (kpi às 12:00Z)
    expect(ehDataPuraUtc(new Date('2026-06-10T12:00:00.500Z'))).toBe(false); // ms ≠ 0
    expect(ehDataPuraUtc(new Date('2026-06-10T00:00:01.000Z'))).toBe(false);
    expect(ehDataPuraUtc(new Date('2026-06-10T21:00:00.000Z'))).toBe(false);
    expect(ehDataPuraUtc(new Date('2026-06-10T13:00:00.000Z'))).toBe(false); // 1h ≠ meio-dia
  });
});
