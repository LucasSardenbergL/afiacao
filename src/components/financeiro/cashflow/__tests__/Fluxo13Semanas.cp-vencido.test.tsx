import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const projMock = vi.fn();
// recharts (ResponsiveContainer) exige ResizeObserver, ausente no jsdom.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: 'oben' }) }));
vi.mock('@/hooks/useCashflowProjection', () => ({ useCashflowProjection: () => projMock() }));
vi.mock('@/components/financeiro/cashflow/AlertasStack', () => ({ AlertasStack: () => null }));

import { Fluxo13Semanas } from '@/components/financeiro/cashflow/Fluxo13Semanas';

type Medida = {
  qtd: number; total: number; vencimento_mais_antigo: string | null;
  faixas: { ate_30: number; de_31_a_60: number; de_61_a_180: number; acima_180: number };
} | null | undefined;

const resposta = (cp: Medida, comCampo = true) => ({
  data: {
    semanas: [{
      inicio: '2026-11-09', fim: '2026-11-15', saldo_inicial: 100000, entradas: [], saidas: [],
      total_entradas: 0, total_saidas: 0, saldo_final: 100000,
    }],
    ncg: {
      aco: { cr_aberto: 0, estoque: 0, adiantamentos: 0, total: 0 },
      pco: { cp_fornecedor: 0, folha_30d: 0, tributos_a_pagar: 0, total: 0 },
      valor: 0, parcial: false, projecao_12m: [],
    },
    indicadores: {
      dias_cobertura: null, liquidez_operacional_liquida: 0, saldo_tesouraria: 0, inadimplencia_pct: 0,
      concentracao_top5_clientes: [], prazo_medio_recebimento: null, prazo_medio_pagamento: null,
      prazo_medio_estoque: null, cash_conversion_cycle: null,
    },
    alertas: [], premissas_aplicadas: {}, confianca_dados: { motivos: [] },
    ...(comCampo ? { cp_vencido_fora_projecao: cp } : {}),
  },
  isLoading: false, error: null,
});

const MEDIDA = {
  qtd: 164, total: 687207.5, vencimento_mais_antigo: '2025-11-19',
  faixas: { ate_30: 75000, de_31_a_60: 47000, de_61_a_180: 383207.5, acima_180: 182000 },
};

describe('Fluxo13Semanas — CP vencido fora da projeção (engine v2.4)', () => {
  it('total > 0: aviso com o total, a contagem e "fora da projeção — conferência pendente", em warning', () => {
    projMock.mockReturnValue(resposta(MEDIDA));
    render(<Fluxo13Semanas />);
    const aviso = screen.getByTestId('cp-vencido-fora-projecao');
    expect(aviso).toHaveTextContent('fora da projeção — conferência pendente');
    expect(aviso).toHaveTextContent(/687\.207,50/);
    expect(aviso).toHaveTextContent(/164 títulos/);
    expect(aviso).toHaveTextContent(/19\/11\/2025/);
    expect(aviso.className).toContain('text-status-warning');
  });

  it('zero REAL: sem aviso', () => {
    projMock.mockReturnValue(resposta({
      qtd: 0, total: 0, vencimento_mais_antigo: null,
      faixas: { ate_30: 0, de_31_a_60: 0, de_61_a_180: 0, acima_180: 0 },
    }));
    render(<Fluxo13Semanas />);
    expect(screen.queryByTestId('cp-vencido-fora-projecao')).not.toBeInTheDocument();
    // controle: o componente renderizou (o assert de ausência não passa por tela vazia)
    expect(screen.getByText(/Projeção 13 semanas/)).toBeInTheDocument();
  });

  it('edge anterior à v2.4 (campo ausente) ou medida null: sem aviso e sem afirmar "R$ 0"', () => {
    for (const r of [resposta(undefined, false), resposta(null)]) {
      projMock.mockReturnValue(r);
      const { unmount } = render(<Fluxo13Semanas />);
      expect(screen.queryByTestId('cp-vencido-fora-projecao')).not.toBeInTheDocument();
      expect(screen.queryByText(/fora da projeção/)).not.toBeInTheDocument();
      expect(screen.getByText(/Projeção 13 semanas/)).toBeInTheDocument();
      unmount();
    }
  });
});
