import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DRETab } from '../DRETab';
import { makeDRE } from './factories';

const row = makeDRE({
  mes: 1,
  receita_bruta: 10000, deducoes: 1000, receita_liquida: 9000, cmv: 4000, lucro_bruto: 5000,
  despesas_operacionais: 1000, despesas_administrativas: 500, despesas_comerciais: 300,
  despesas_financeiras: 100, receitas_financeiras: 50, resultado_operacional: 3150,
  impostos: 600, resultado_liquido: 2550,
});

describe('DRETab', () => {
  it('vazio → mensagem de recalcular', () => {
    render(<DRETab data={[]} view="all" ano={2026} />);
    expect(screen.getByText(/Nenhum DRE calculado para 2026/)).toBeTruthy();
  });

  it('com dados → cabeçalho, linhas do DRE, mês e badge consolidado', () => {
    render(<DRETab data={[row]} view="all" ano={2026} />);
    expect(screen.getByText(/DRE Regime de Caixa/)).toBeTruthy();
    expect(screen.getByText('Receita Bruta')).toBeTruthy();
    expect(screen.getByText('= RESULTADO LÍQUIDO')).toBeTruthy();
    expect(screen.getByText('Jan')).toBeTruthy();
    expect(screen.getByText('Consolidado')).toBeTruthy();
  });

  it('categorias não mapeadas → aviso de heurística', () => {
    const unmapped = [{ ...row, detalhamento: { receitas: {}, despesas: {}, categorias_nao_mapeadas: ['CAT_X'] } }];
    render(<DRETab data={unmapped} view="all" ano={2026} />);
    expect(screen.getByText(/classificadas por heurística/)).toBeTruthy();
    expect(screen.getByText(/CAT_X/)).toBeTruthy();
  });
});
