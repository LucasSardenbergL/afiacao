import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Tile "Vendedores ativos" do Master: conta só pedido lançado NO APP (`hash_payload IS NULL`) — a venda
 * importada do Omie não é atividade (spec 2026-10-06 §5.5). Ao lado da receita, que inclui a importada,
 * "0 ativos" sem o "no app" é lido como "o time não vendeu".
 */
vi.mock('@/hooks/useTeamKpis', () => ({
  useTeamKpis: () => ({
    isLoading: false,
    isError: false,
    data: { ativosHoje: 0, ativos7d: 0, receitaHoje: 5000, receitaMes: 90000, variacaoMes: null },
  }),
}));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ selection: 'oben', companyInfo: { shortName: 'Oben' } }),
}));

import { TeamKpiTiles } from '../TeamKpiTiles';

describe('TeamKpiTiles — vendedores ativos', () => {
  it('[TILE-NO-APP] o sub do tile diz que a atividade é no app', () => {
    render(<TeamKpiTiles />);
    expect(screen.getByText('ativos no app hoje · 7d: 0')).toBeTruthy();
  });
});
