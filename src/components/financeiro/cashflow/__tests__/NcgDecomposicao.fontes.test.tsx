import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Engine v2.6+: `ncg.fontes.{folha,tributos} === false` = parcela NÃO medida. O 0 que vem nela é ausência
// de dado — o card não pode apresentar a PCO como completa ("ausente ≠ zero").
const projMock = vi.fn();
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: 'oben' }) }));
vi.mock('@/hooks/useCashflowProjection', () => ({ useCashflowProjection: () => projMock() }));

import { NcgDecomposicao } from '@/components/financeiro/cashflow/NcgDecomposicao';

const comFontes = (fontes: { folha: boolean; tributos: boolean } | undefined) => ({
  data: {
    semanas: [],
    ncg: {
      aco: { cr_aberto: 1000, estoque: 0, adiantamentos: 0, total: 1000 },
      pco: { cp_fornecedor: 500, folha_30d: 0, tributos_a_pagar: 0, total: 500 },
      valor: 500, parcial: false, projecao_12m: [], ...(fontes ? { fontes } : {}),
    },
    indicadores: {
      dias_cobertura: null, liquidez_operacional_liquida: 0, saldo_tesouraria: 0, inadimplencia_pct: 0,
      concentracao_top5_clientes: [], prazo_medio_recebimento: null, prazo_medio_pagamento: null,
      prazo_medio_estoque: 0, cash_conversion_cycle: null,
    },
    alertas: [], premissas_aplicadas: {}, confianca_dados: { motivos: [] },
  },
  isLoading: false, error: null,
});

describe('NcgDecomposicao — folha/tributos sem fonte ≠ zero', () => {
  it('folha sem fonte: PCO marcada parcial nomeando a folha', () => {
    projMock.mockReturnValue(comFontes({ folha: false, tributos: true }));
    render(<NcgDecomposicao />);
    expect(screen.getByText('⚠ Parcial — sem fonte: folha')).toBeInTheDocument();
    expect(screen.getByText('⚠ NCG parcial — PCO sem todas as fontes')).toBeInTheDocument();
  });

  it('as duas sem fonte: nomeia folha e tributos', () => {
    projMock.mockReturnValue(comFontes({ folha: false, tributos: false }));
    render(<NcgDecomposicao />);
    expect(screen.getByText('⚠ Parcial — sem fonte: folha e tributos')).toBeInTheDocument();
  });

  it('as duas medidas (zero medido): PCO completa, sem aviso', () => {
    projMock.mockReturnValue(comFontes({ folha: true, tributos: true }));
    render(<NcgDecomposicao />);
    expect(screen.queryByText(/Parcial — sem fonte/)).not.toBeInTheDocument();
    expect(screen.getByText('CP fornecedor + Folha + Tributos')).toBeInTheDocument();
    expect(screen.queryByText(/NCG parcial — PCO/)).not.toBeInTheDocument();
  });

  it('engine anterior (sem `fontes`): mantém o rótulo de sempre', () => {
    projMock.mockReturnValue(comFontes(undefined));
    render(<NcgDecomposicao />);
    expect(screen.queryByText(/Parcial — sem fonte/)).not.toBeInTheDocument();
  });
});
