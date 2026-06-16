import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewExperimentDialog } from '../NewExperimentDialog';

describe('NewExperimentDialog', () => {
  it('abre o dialog ao clicar em Novo', () => {
    render(<NewExperimentDialog onCreate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Novo/ }));
    expect(screen.getByText('Novo Experimento Comercial')).toBeTruthy();
  });

  it('NÃO cria sem título e hipótese', () => {
    const onCreate = vi.fn();
    render(<NewExperimentDialog onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: /Novo/ }));
    fireEvent.click(screen.getByRole('button', { name: /Criar Experimento/ }));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('cria com os defaults quando título e hipótese estão preenchidos', () => {
    const onCreate = vi.fn();
    render(<NewExperimentDialog onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: /Novo/ }));
    fireEvent.change(screen.getByPlaceholderText('Título do experimento'), { target: { value: 'Meu teste' } });
    fireEvent.change(screen.getByPlaceholderText(/Hipótese:/), { target: { value: 'Minha hipótese' } });
    fireEvent.click(screen.getByRole('button', { name: /Criar Experimento/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Meu teste',
        hypothesis: 'Minha hipótese',
        primary_metric: 'margem_por_hora',
        min_duration_days: 14,
        min_sample_size: 10,
        min_significance: 0.95,
      }),
    );
  });
});
