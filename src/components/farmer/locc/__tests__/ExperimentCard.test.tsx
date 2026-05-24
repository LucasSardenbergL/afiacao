import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExperimentCard } from '../ExperimentCard';
import type { Experiment } from '@/hooks/useFarmerExperiments';

function exp(partial: Partial<Experiment>): Experiment {
  return {
    id: 'e1',
    title: 'Teste churn',
    hypothesis: 'Ligar mais reduz churn',
    primary_metric: 'margem_por_hora',
    status: 'rascunho',
    control_count: 0,
    test_count: 0,
    control_metric_value: 0,
    test_metric_value: 0,
    lift_pct: 0,
    winner: null,
    p_value: null,
    ...partial,
  } as unknown as Experiment;
}

describe('ExperimentCard', () => {
  it('rascunho: mostra título/hipótese e botão Iniciar dispara onStart', () => {
    const onStart = vi.fn();
    render(<ExperimentCard experiment={exp({})} onStart={onStart} onMeasure={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('Teste churn')).toBeTruthy();
    expect(screen.getByText('Ligar mais reduz churn')).toBeTruthy();
    expect(screen.getByText('Margem/Hora')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Iniciar/ }));
    expect(onStart).toHaveBeenCalledWith('e1');
  });

  it('ativo: botões Medir e Cancelar disparam os handlers', () => {
    const onMeasure = vi.fn();
    const onCancel = vi.fn();
    render(
      <ExperimentCard
        experiment={exp({ status: 'ativo', control_metric_value: 1.2, test_metric_value: 1.5, lift_pct: 25 })}
        onStart={() => {}}
        onMeasure={onMeasure}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Medir/ }));
    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[buttons.length - 1]); // botão de cancelar (ícone)
    expect(onMeasure).toHaveBeenCalledWith('e1');
    expect(onCancel).toHaveBeenCalledWith('e1');
  });

  it('concluido: mostra o vencedor', () => {
    render(
      <ExperimentCard
        experiment={exp({ status: 'concluido', winner: 'teste', lift_pct: 12.3, p_value: 0.03 })}
        onStart={() => {}}
        onMeasure={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/🏆 Teste/)).toBeTruthy();
  });
});
