import { describe, it, expect } from 'vitest';
import { agregarVendasDiaKpi } from '../vendas-kpi-dia';

// Alinhado ao dashboard Master (useTeamKpis/somarReceita): a verdade do dia é
// `order_date_kpi` (coluna `date` pura, 'YYYY-MM-DD'), comparada por STRING — sem
// Date local, logo TZ-agnóstico por construção. "Faturado" = só pedido VÁLIDO
// (status ∉ {cancelado, rascunho}); soft-deletados já saem na query (deleted_at).
const HOJE = '2026-06-10';

describe('agregarVendasDiaKpi', () => {
  it('pedido válido de HOJE conta em faturadoHoje + pedidosHoje', () => {
    const agg = agregarVendasDiaKpi(
      [{ total: 1500, status: 'enviado', order_date_kpi: '2026-06-10' }],
      HOJE,
    );
    expect(agg).toEqual({ faturadoHoje: 1500, pedidosHoje: 1, faturadoOntem: 0 });
  });

  it('pedido válido de ONTEM conta em faturadoOntem, não em hoje', () => {
    const agg = agregarVendasDiaKpi(
      [{ total: 700, status: 'faturado', order_date_kpi: '2026-06-09' }],
      HOJE,
    );
    expect(agg).toEqual({ faturadoHoje: 0, pedidosHoje: 0, faturadoOntem: 700 });
  });

  it('cancelado e rascunho NÃO contam como faturado (nem em hoje nem em ontem)', () => {
    const agg = agregarVendasDiaKpi(
      [
        { total: 999, status: 'cancelado', order_date_kpi: '2026-06-10' },
        { total: 999, status: 'rascunho', order_date_kpi: '2026-06-10' },
        { total: 999, status: 'cancelado', order_date_kpi: '2026-06-09' },
      ],
      HOJE,
    );
    expect(agg).toEqual({ faturadoHoje: 0, pedidosHoje: 0, faturadoOntem: 0 });
  });

  it('order_date_kpi null não conta em dia nenhum', () => {
    const agg = agregarVendasDiaKpi(
      [{ total: 500, status: 'faturado', order_date_kpi: null }],
      HOJE,
    );
    expect(agg).toEqual({ faturadoHoje: 0, pedidosHoje: 0, faturadoOntem: 0 });
  });

  it('total como string numérica (numeric do Postgres) e null somam como esperado', () => {
    const agg = agregarVendasDiaKpi(
      [
        { total: '150.5', status: 'enviado', order_date_kpi: '2026-06-10' },
        { total: null, status: 'faturado', order_date_kpi: '2026-06-10' },
      ],
      HOJE,
    );
    expect(agg).toEqual({ faturadoHoje: 150.5, pedidosHoje: 2, faturadoOntem: 0 });
  });

  it('order_date_kpi como timestamp (defensivo) usa o dia via slice(0,10)', () => {
    const agg = agregarVendasDiaKpi(
      [{ total: 80, status: 'enviado', order_date_kpi: '2026-06-10T00:00:00.000Z' }],
      HOJE,
    );
    expect(agg).toEqual({ faturadoHoje: 80, pedidosHoje: 1, faturadoOntem: 0 });
  });

  it('fora dos 2 dias (anteontem, amanhã) não conta', () => {
    const agg = agregarVendasDiaKpi(
      [
        { total: 999, status: 'faturado', order_date_kpi: '2026-06-08' },
        { total: 999, status: 'faturado', order_date_kpi: '2026-06-11' },
      ],
      HOJE,
    );
    expect(agg).toEqual({ faturadoHoje: 0, pedidosHoje: 0, faturadoOntem: 0 });
  });

  it('virada de mês: hoje = 1º → ontem = último dia do mês anterior', () => {
    const agg = agregarVendasDiaKpi(
      [
        { total: 100, status: 'faturado', order_date_kpi: '2026-07-01' },
        { total: 200, status: 'faturado', order_date_kpi: '2026-06-30' },
      ],
      '2026-07-01',
    );
    expect(agg).toEqual({ faturadoHoje: 100, pedidosHoje: 1, faturadoOntem: 200 });
  });

  it('cada pedido válido conta em exatamente 1 dia (Σ não duplica)', () => {
    const rows = [
      { total: 100, status: 'faturado', order_date_kpi: '2026-06-10' },
      { total: 100, status: 'enviado', order_date_kpi: '2026-06-09' },
      { total: 100, status: 'separacao', order_date_kpi: '2026-06-10' },
    ];
    const agg = agregarVendasDiaKpi(rows, HOJE);
    expect(agg.faturadoHoje + agg.faturadoOntem).toBe(300);
    expect(agg).toEqual({ faturadoHoje: 200, pedidosHoje: 2, faturadoOntem: 100 });
  });
});
