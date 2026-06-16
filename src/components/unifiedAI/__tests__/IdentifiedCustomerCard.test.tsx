import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IdentifiedCustomerCard } from '../IdentifiedCustomerCard';
import { type AICustomerMatch } from '../types';

const customer: AICustomerMatch = {
  nome_fantasia: 'Metalúrgica SP',
  razao_social: 'Metalurgica Sao Paulo LTDA',
  cnpj_cpf: '12.345.678/0001-90',
  cidade: 'Curitiba',
  codigo_cliente: 42,
  confidence: 'high',
};

describe('IdentifiedCustomerCard', () => {
  it('renderiza nome, cidade, cnpj e badge de confiança', () => {
    render(<IdentifiedCustomerCard customer={customer} onConfirm={() => {}} />);
    expect(screen.getByText('Metalúrgica SP')).toBeTruthy();
    expect(screen.getByText('Curitiba')).toBeTruthy();
    expect(screen.getByText('12.345.678/0001-90')).toBeTruthy();
    expect(screen.getByText('Alta confiança')).toBeTruthy();
  });

  it('mostra rótulos de confiança média/baixa', () => {
    const { rerender } = render(
      <IdentifiedCustomerCard customer={{ ...customer, confidence: 'medium' }} onConfirm={() => {}} />,
    );
    expect(screen.getByText('Confiança média')).toBeTruthy();
    rerender(<IdentifiedCustomerCard customer={{ ...customer, confidence: 'low' }} onConfirm={() => {}} />);
    expect(screen.getByText('Baixa confiança')).toBeTruthy();
  });

  it('dispara onConfirm ao clicar em Selecionar', () => {
    const onConfirm = vi.fn();
    render(<IdentifiedCustomerCard customer={customer} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: /Selecionar/ }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
