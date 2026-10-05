import { describe, it, expect } from 'vitest';
import { format } from 'date-fns';
import {
  DIAS_SEM_COMPRA,
  horaDaLeitura,
  leituraDaQuery,
  motivoSemMetrica,
  rotuloConsolidado,
  rotuloFaturamento12m,
  rotuloMetrica,
  rotuloUltimaCompra,
} from '../kpi-rotulos';
import { formatBRL, formatDateOrDash } from '../format';
import type { CustomerMetrics, Faturamento12m, LeituraKpi } from '../viewTypes';

/** Instante fixo da leitura do navegador; a hora exibida sai de `horaDaLeitura` (fuso local). */
const LIDO_EM = Date.UTC(2026, 9, 5, 17, 32);
const REFRESH_MV = '2026-10-05T12:15:00+00:00';

type Metricas = NonNullable<CustomerMetrics>;
const metricas = (over: Record<string, unknown> = {}): Metricas =>
  ({
    faturamento_90d: 0,
    faturamento_prev_90d: 0,
    ticket_medio_90d: 0,
    pedidos_90d: 0,
    dias_desde_ultima_compra: 12,
    intervalo_medio_dias: null,
    ultima_compra_data: null,
    is_cold_start: true,
    calculated_at: REFRESH_MV,
    ...over,
  }) as unknown as Metricas;

const lido = <T>(valor: T, desatualizado: 'erro' | 'sem-rede' | null = null): LeituraKpi<T> => ({
  emMaos: true,
  valor,
  desatualizado,
  lidoEm: LIDO_EM,
});
const semValor = <T>(motivo: 'carregando' | 'erro' | 'sem-rede' | 'desabilitada'): LeituraKpi<T> => ({
  emMaos: false,
  motivo,
});

type Status = 'pending' | 'error' | 'success';
type Busca = 'fetching' | 'paused' | 'idle';
const q = <T>(status: Status, fetchStatus: Busca, data: T | undefined) => ({
  status,
  fetchStatus,
  data,
  dataUpdatedAt: LIDO_EM,
});

describe('leituraDaQuery — a ponte react-query → faixa, por ESTADO (nunca `isError && !data`)', () => {
  const valor: Faturamento12m = { total: 1000, pedidos: 1 };

  it('sem dado: o MOTIVO — carregando, sem rede, falha, desabilitada', () => {
    expect(leituraDaQuery(q('pending', 'fetching', undefined))).toEqual({ emMaos: false, motivo: 'carregando' });
    // o 4º estado: offline na 1ª carga (`pending` + `paused`, `isError` falso) não é "carregando…" eterno
    expect(leituraDaQuery(q('pending', 'paused', undefined))).toEqual({ emMaos: false, motivo: 'sem-rede' });
    expect(leituraDaQuery(q('error', 'idle', undefined))).toEqual({ emMaos: false, motivo: 'erro' });
    expect(leituraDaQuery(q('pending', 'idle', undefined))).toEqual({ emMaos: false, motivo: 'desabilitada' });
  });

  it('com dado e leitura boa: em mãos, sem aviso — inclusive revalidando em background', () => {
    expect(leituraDaQuery(q('success', 'idle', valor))).toEqual({
      emMaos: true,
      valor,
      desatualizado: null,
      lidoEm: LIDO_EM,
    });
    expect(leituraDaQuery(q('success', 'fetching', valor))).toMatchObject({ emMaos: true, desatualizado: null });
  });

  it('com dado e o refetch FALHOU (ou ficou sem rede): o valor fica e se declara desatualizado (P1-1)', () => {
    expect(leituraDaQuery(q('error', 'idle', valor))).toMatchObject({ emMaos: true, valor, desatualizado: 'erro' });
    expect(leituraDaQuery(q('success', 'paused', valor))).toMatchObject({ emMaos: true, desatualizado: 'sem-rede' });
  });

  it('`null` É dado (a MV sem a linha do cliente) — não se confunde com "não li"', () => {
    expect(leituraDaQuery(q('success', 'idle', null))).toEqual({
      emMaos: true,
      valor: null,
      desatualizado: null,
      lidoEm: LIDO_EM,
    });
  });
});

describe('Customer 360 — faturamento 12m: R$ só quando LIDO', () => {
  it('sem valor → "—" com o motivo, nunca R$ 0', () => {
    expect(rotuloFaturamento12m(semValor('erro'))).toEqual({ value: '—', hint: 'indisponível' });
    expect(rotuloFaturamento12m(semValor('carregando'))).toEqual({ value: '—', hint: 'carregando…' });
    expect(rotuloFaturamento12m(semValor('sem-rede'))).toEqual({ value: '—', hint: 'sem rede' });
    expect(rotuloFaturamento12m(semValor('desabilitada'))).toEqual({ value: '—', hint: undefined });
  });

  it('lido: o número e a contagem — inclusive o zero de verdade (cliente sem venda em 12m)', () => {
    expect(rotuloFaturamento12m(lido({ total: 904595.43, pedidos: 706 }))).toEqual({
      value: formatBRL(904595.43),
      hint: '706 pedidos',
    });
    expect(rotuloFaturamento12m(lido({ total: 0, pedidos: 0 }))).toEqual({ value: formatBRL(0), hint: '0 pedidos' });
  });

  it('lido e NÃO atualizado: o valor fica e diz de quando é (P1-1)', () => {
    expect(rotuloFaturamento12m(lido({ total: 1000, pedidos: 8 }, 'erro'))).toEqual({
      value: formatBRL(1000),
      hint: `8 pedidos · lido às ${horaDaLeitura(LIDO_EM)}`,
    });
    expect(rotuloFaturamento12m(lido({ total: 1000, pedidos: 8 }, 'sem-rede')).hint).toBe(
      `8 pedidos · lido às ${horaDaLeitura(LIDO_EM)}`,
    );
  });
});

describe('Customer 360 — última compra pelo consolidado (customer_metrics_mv)', () => {
  it(`o sentinela ${DIAS_SEM_COMPRA} é "Sem compra no consolidado" — nem "${DIAS_SEM_COMPRA}d", nem "Nunca" (P1-2)`, () => {
    expect(rotuloUltimaCompra(lido(metricas({ dias_desde_ultima_compra: DIAS_SEM_COMPRA })))).toEqual({
      value: 'Sem compra',
      hint: 'no consolidado',
    });
  });

  it('dias medidos aparecem como dias, com o intervalo médio ou a data da compra', () => {
    expect(rotuloUltimaCompra(lido(metricas({ dias_desde_ultima_compra: 12, intervalo_medio_dias: 29.6 })))).toEqual({
      value: '12d',
      hint: 'Intervalo médio ~30d',
    });
    expect(
      rotuloUltimaCompra(lido(metricas({ dias_desde_ultima_compra: 3, ultima_compra_data: '2026-10-02' }))),
    ).toEqual({ value: '3d', hint: formatDateOrDash('2026-10-02') });
    expect(rotuloUltimaCompra(lido(metricas({ dias_desde_ultima_compra: 0 })))).toEqual({ value: '0d', hint: undefined });
  });

  it('sem a linha: "—" com o motivo — fora do consolidado, falha, sem rede', () => {
    expect(rotuloUltimaCompra(lido<CustomerMetrics>(null))).toEqual({ value: '—', hint: 'fora do consolidado' });
    expect(rotuloUltimaCompra(semValor('erro'))).toEqual({ value: '—', hint: 'indisponível' });
    expect(rotuloUltimaCompra(semValor('sem-rede'))).toEqual({ value: '—', hint: 'sem rede' });
  });
});

describe('Customer 360 — tiles do consolidado sem R$ 0 fabricado', () => {
  const ler = (m: Metricas) => formatBRL(Number(m.faturamento_90d));

  it('sem a linha → "—"; lido → o valor da MV, inclusive 0', () => {
    expect(rotuloMetrica(semValor('erro'), ler)).toBe('—');
    expect(rotuloMetrica(lido<CustomerMetrics>(null), ler)).toBe('—');
    expect(rotuloMetrica(lido(metricas({ faturamento_90d: 0 })), ler)).toBe(formatBRL(0));
  });

  it('o MOTIVO de não haver valor: fora do consolidado ≠ falha ≠ sem rede ≠ carregando (P2)', () => {
    expect(motivoSemMetrica(lido<CustomerMetrics>(null))).toBe('fora do consolidado');
    expect(motivoSemMetrica(semValor('erro'))).toBe('indisponível');
    expect(motivoSemMetrica(semValor('sem-rede'))).toBe('sem rede');
    expect(motivoSemMetrica(semValor('carregando'))).toBe('carregando…');
    expect(motivoSemMetrica(lido(metricas()))).toBeUndefined();
  });
});

describe('Customer 360 — os dois relógios da faixa, declarados (P1-2)', () => {
  it('o consolidado diz a hora do REFRESH da MV (`calculated_at`) — não a hora em que o navegador leu', () => {
    const r = rotuloConsolidado(lido(metricas({ calculated_at: REFRESH_MV })));
    expect(r).toContain('Faturamento 12m: leitura direta dos pedidos');
    expect(r).toContain(`consolidado em ${format(new Date(REFRESH_MV), "dd/MM 'às' HH:mm")}`);
    expect(r).not.toContain(horaDaLeitura(LIDO_EM));
  });

  it('sem a linha (ou sem o carimbo) não há o que declarar', () => {
    expect(rotuloConsolidado(lido<CustomerMetrics>(null))).toBeNull();
    expect(rotuloConsolidado(semValor('erro'))).toBeNull();
    expect(rotuloConsolidado(lido(metricas({ calculated_at: null })))).toBeNull();
  });
});
