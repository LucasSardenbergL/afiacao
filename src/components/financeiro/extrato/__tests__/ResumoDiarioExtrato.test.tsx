import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResumoDiarioExtrato } from '../ResumoDiarioExtrato';
import type { ResumoDia } from '@/services/financeiroExtratoBancario';

const diaNaoCoberto: ResumoDia = { data: '2026-11-10', coberto: false, creditos: null, debitos: null, saldoFinal: null };
const diaCobertoSemMovimento: ResumoDia = { data: '2026-11-11', coberto: true, creditos: 0, debitos: 0, saldoFinal: 150000 };

describe('ResumoDiarioExtrato — ausente ≠ zero', () => {
  it('dia NÃO coberto mostra "indisponível" e nunca R$ 0,00', () => {
    const { container } = render(<ResumoDiarioExtrato dias={[diaNaoCoberto]} />);
    expect(screen.getAllByText('indisponível').length).toBeGreaterThanOrEqual(3);
    expect(container.textContent).not.toContain('R$ 0,00');
    expect(container.textContent).not.toMatch(/R\$\s?0,00/);
  });

  it('dia coberto com créditos 0 mostra R$ 0,00 (zero real)', () => {
    const { container } = render(<ResumoDiarioExtrato dias={[diaCobertoSemMovimento]} />);
    expect(container.textContent).toMatch(/R\$\s?0,00/);
    expect(container.textContent).toMatch(/R\$\s?1\.500,00/);
  });

  it('dia coberto com saldo null (arquivos divergentes) mostra indisponível no saldo, não 0', () => {
    const { container } = render(
      <ResumoDiarioExtrato dias={[{ ...diaCobertoSemMovimento, saldoFinal: null }]} />,
    );
    expect(screen.getAllByText('indisponível').length).toBeGreaterThanOrEqual(2); // saldo + Omie
    expect(container.textContent).toMatch(/R\$\s?0,00/); // créditos/débitos reais
  });

  it('coluna Omie é "indisponível" mesmo em dia coberto (Task 9b liga depois)', () => {
    render(<ResumoDiarioExtrato dias={[diaCobertoSemMovimento]} />);
    expect(screen.getAllByText('indisponível').length).toBe(1);
  });
});
