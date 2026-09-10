import { describe, it, expect, vi, afterEach } from 'vitest';
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

// ─────────────────────────────────────────────────────────────────────────────────
// A projeção que a TELA mostra. O teste da função pura (fluxo-caixa-semanas.test.ts)
// prova a aritmética; este prova que ela CHEGA ao consumidor — trocar o cálculo sem
// religar a tela deixaria a correção inerte, e só este caso pega isso.
// ─────────────────────────────────────────────────────────────────────────────────
describe('FluxoCaixaTab — saldo projetado na tela', () => {
  afterEach(() => vi.useRealTimers());

  // Meio-dia UTC ⇒ 09h em São Paulo: o mesmo dia de negócio nos dois fusos.
  const congelarEm9Set = () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-09T12:00:00Z'));
  };

  const comPassadoEFuturo = [
    // Semana inteiramente passada, com movimento — já dentro do saldo em conta.
    makeFluxoDia({ data: '2026-09-01', entradas_realizadas: 100_000, saidas_realizadas: 40_000 }),
    // Semana corrente: 07/09 já aconteceu, 11/09 ainda não.
    makeFluxoDia({ data: '2026-09-07', entradas_realizadas: 20_000, saidas_realizadas: 5_000 }),
    makeFluxoDia({ data: '2026-09-11', entradas_previstas: 8_000, saidas_previstas: 3_000 }),
    makeFluxoDia({ data: '2026-09-16', entradas_previstas: 10_000, saidas_previstas: 25_000 }),
  ];

  it('parte do saldo de hoje e soma só o que falta acontecer', () => {
    congelarEm9Set();
    render(<FluxoCaixaTab data={comPassadoEFuturo} loading={false} saldoCC={500_000} />);

    // 500k + (8k − 3k) na semana corrente, e −15k na seguinte.
    expect(screen.getByText('R$ 505.0k')).toBeTruthy();
    expect(screen.getByText('R$ 490.0k')).toBeTruthy();

    // Somando o passado por cima do saldo (o defeito) daria estes:
    expect(screen.queryByText('R$ 580.0k')).toBeNull();
    expect(screen.queryByText('R$ 565.0k')).toBeNull();
  });

  it('sem saldo em conta → "—" e aviso, nunca curva a partir de zero', () => {
    congelarEm9Set();
    render(<FluxoCaixaTab data={comPassadoEFuturo} loading={false} />);

    expect(screen.getByText(/Saldo bancário indisponível/)).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // Com `saldoCC || 0`, a projeção sairia ancorada em zero e apareceria como número firme.
    expect(screen.queryByText('R$ 5.0k')).toBeNull();
    expect(screen.queryByText('R$ -10.0k')).toBeNull();
  });

  it('saldo zero CONHECIDO continua sendo número, não "—"', () => {
    congelarEm9Set();
    render(<FluxoCaixaTab data={comPassadoEFuturo} loading={false} saldoCC={0} />);
    expect(screen.queryByText(/Saldo bancário indisponível/)).toBeNull();
    expect(screen.getByText('R$ 5.0k')).toBeTruthy();
  });
});
