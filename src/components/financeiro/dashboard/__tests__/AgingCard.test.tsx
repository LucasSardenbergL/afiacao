import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgingCard } from '../AgingCard';

const data = {
  a_vencer_valor: 1000, a_vencer_qtd: 2,
  vencido_1_30_valor: 500, vencido_1_30_qtd: 1,
  vencido_31_60_valor: 0, vencido_31_60_qtd: 0,
  vencido_61_90_valor: 0, vencido_61_90_qtd: 0,
  vencido_90_plus_valor: 250, vencido_90_plus_qtd: 1,
};

describe('AgingCard', () => {
  it('sem data → título + skeleton, sem faixas', () => {
    render(<AgingCard title="Aging Recebíveis" data={null} type="receber" />);
    expect(screen.getByText('Aging Recebíveis')).toBeTruthy();
    expect(screen.queryByText('A vencer (2)')).toBeNull();
  });

  it('com data → 5 faixas e total', () => {
    render(<AgingCard title="Aging Recebíveis" data={data} type="receber" />);
    expect(screen.getByText('A vencer (2)')).toBeTruthy();
    expect(screen.getByText('1-30 dias (1)')).toBeTruthy();
    expect(screen.getByText('31-60 dias (0)')).toBeTruthy();
    expect(screen.getByText('61-90 dias (0)')).toBeTruthy();
    expect(screen.getByText('+90 dias (1)')).toBeTruthy();
    expect(screen.getByText(/Total:/)).toBeTruthy();
  });
});
