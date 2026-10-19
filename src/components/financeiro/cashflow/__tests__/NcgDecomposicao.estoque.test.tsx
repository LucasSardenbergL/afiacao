import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const projMock = vi.fn();
// recharts (ResponsiveContainer) exige ResizeObserver, ausente no jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: 'oben' }) }));
vi.mock('@/hooks/useCashflowProjection', () => ({ useCashflowProjection: () => projMock() }));

import { NcgDecomposicao } from '@/components/financeiro/cashflow/NcgDecomposicao';

const base = (estoque: number | null, pme: number | null) => ({
  data: {
    semanas: [],
    ncg: {
      aco: { cr_aberto: 1000, estoque, adiantamentos: 0, total: 1000 + (estoque ?? 0) },
      pco: { cp_fornecedor: 500, folha_30d: 0, tributos_a_pagar: 0, total: 500 },
      valor: 500 + (estoque ?? 0), parcial: estoque === null, projecao_12m: [],
    },
    indicadores: {
      dias_cobertura: null, liquidez_operacional_liquida: 0, saldo_tesouraria: 0, inadimplencia_pct: 0,
      concentracao_top5_clientes: [], prazo_medio_recebimento: null, prazo_medio_pagamento: null,
      prazo_medio_estoque: pme, cash_conversion_cycle: null,
    },
    alertas: [], premissas_aplicadas: {}, confianca_dados: { motivos: [] },
  },
  isLoading: false, error: null,
});

describe('NcgDecomposicao — estoque ausente ≠ zero', () => {
  it('estoque null: NCG marcada parcial e PME —', () => {
    projMock.mockReturnValue(base(null, null));
    render(<NcgDecomposicao />);
    expect(screen.getByText(/parcial — sem estoque/)).toBeInTheDocument();
    expect(screen.queryByText('0d')).not.toBeInTheDocument();
  });

  it('estoque 0 de verdade: sem aviso de parcial', () => {
    projMock.mockReturnValue(base(0, 0));
    render(<NcgDecomposicao />);
    expect(screen.queryByText(/parcial — sem estoque/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Estoque não informado/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Estoque não confirmado/)).not.toBeInTheDocument();
  });

  it('resposta pré-v1.5 (sem `parcial`) com estoque 0: aviso de não confirmado', () => {
    const r = base(0, 0);
    delete (r.data.ncg as { parcial?: boolean }).parcial;
    projMock.mockReturnValue(r);
    render(<NcgDecomposicao />);
    expect(screen.getByText(/Estoque não confirmado/)).toBeInTheDocument();
  });
});
