import { describe, it, expect } from 'vitest';
import { DIAS_SEM_COMPRA, rotuloFaturamento12m, rotuloMetrica, rotuloUltimaCompra } from '../kpi-rotulos';
import { formatBRL } from '../format';
import type { CustomerMetrics, RevenueDerived } from '../viewTypes';

const metricas = (over: Record<string, unknown> = {}): CustomerMetrics =>
  ({
    faturamento_90d: 0,
    faturamento_prev_90d: 0,
    ticket_medio_90d: 0,
    pedidos_90d: 0,
    dias_desde_ultima_compra: 12,
    intervalo_medio_dias: null,
    ultima_compra_data: null,
    is_cold_start: true,
    ...over,
  }) as unknown as CustomerMetrics;

const receita = (over: Partial<RevenueDerived>): RevenueDerived => ({
  last12: null,
  orderCount12m: null,
  faturamentoIndisponivel: false,
  metricasIndisponiveis: false,
  ...over,
});

describe('Customer 360 — faturamento 12m: R$ 0 só quando LIDO', () => {
  it('leitura que falhou → "—" com "indisponível", nunca R$ 0', () => {
    expect(rotuloFaturamento12m(receita({ faturamentoIndisponivel: true }))).toEqual({ value: '—', hint: 'indisponível' });
  });

  it('ainda carregando → "—" com "carregando…"', () => {
    expect(rotuloFaturamento12m(receita({}))).toEqual({ value: '—', hint: 'carregando…' });
  });

  it('lido: o número e a contagem — inclusive o zero de verdade (cliente sem venda em 12m)', () => {
    expect(rotuloFaturamento12m(receita({ last12: 904595.43, orderCount12m: 706 }))).toEqual({
      value: formatBRL(904595.43),
      hint: '706 pedidos',
    });
    expect(rotuloFaturamento12m(receita({ last12: 0, orderCount12m: 0 }))).toEqual({ value: formatBRL(0), hint: '0 pedidos' });
  });
});

describe('Customer 360 — última compra pelo customer_metrics_mv', () => {
  it(`o sentinela ${DIAS_SEM_COMPRA} da MV é "Nunca", não "${DIAS_SEM_COMPRA}d"`, () => {
    expect(rotuloUltimaCompra(metricas({ dias_desde_ultima_compra: DIAS_SEM_COMPRA }), false)).toBe('Nunca');
  });

  it('dias medidos aparecem como dias', () => {
    expect(rotuloUltimaCompra(metricas({ dias_desde_ultima_compra: 12 }), false)).toBe('12d');
    expect(rotuloUltimaCompra(metricas({ dias_desde_ultima_compra: 0 }), false)).toBe('0d');
  });

  it('cliente fora da MV ou leitura que falhou → "—" (não se afirma "Nunca")', () => {
    expect(rotuloUltimaCompra(null as CustomerMetrics, false)).toBe('—');
    expect(rotuloUltimaCompra(metricas(), true)).toBe('—');
  });
});

describe('Customer 360 — tiles do 90d sem R$ 0 fabricado', () => {
  it('falha ou cliente fora da MV → "—"; lido → o valor da MV, inclusive 0', () => {
    const ler = (m: NonNullable<CustomerMetrics>) => formatBRL(Number(m.faturamento_90d));
    expect(rotuloMetrica(metricas(), true, ler)).toBe('—');
    expect(rotuloMetrica(null as CustomerMetrics, false, ler)).toBe('—');
    expect(rotuloMetrica(metricas({ faturamento_90d: 0 }), false, ler)).toBe(formatBRL(0));
  });
});
