import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FluxoCaixaTab } from '../FluxoCaixaTab';
import { makeFluxoDia } from './factories';

const days = [
  makeFluxoDia({ data: '2026-01-05', entradas_realizadas: 1000, saidas_realizadas: 400 }),
  makeFluxoDia({ data: '2099-01-05', entradas_previstas: 800, saidas_previstas: 300 }),
];

describe('FluxoCaixaTab', () => {
  it('loading → skeleton (sem título do gráfico)', () => {
    render(<FluxoCaixaTab data={[]} loading={true} />);
    expect(screen.queryByText('Fluxo de Caixa Semanal')).toBeNull();
  });

  it('vazio → mensagem de sincronizar', () => {
    render(<FluxoCaixaTab data={[]} loading={false} />);
    expect(screen.getByText(/Nenhum dado de fluxo de caixa/)).toBeTruthy();
  });

  it('com dados → KPIs e gráfico semanal', () => {
    render(<FluxoCaixaTab data={days} loading={false} saldoCC={5000} />);
    expect(screen.getByText('Fluxo de Caixa Semanal')).toBeTruthy();
    expect(screen.getByText('Recebido')).toBeTruthy();
    expect(screen.getByText('Pago')).toBeTruthy();
    expect(screen.getByText('Saldo CC Atual')).toBeTruthy();
  });
});
