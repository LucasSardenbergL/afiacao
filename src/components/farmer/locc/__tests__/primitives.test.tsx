import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TabSkeleton, MetricRow, WeightBar } from '../primitives';

describe('MetricRow', () => {
  it('renderiza label e value', () => {
    render(<MetricRow label="Margem/Hora" value="R$ 10,00" />);
    expect(screen.getByText('Margem/Hora')).toBeTruthy();
    expect(screen.getByText('R$ 10,00')).toBeTruthy();
  });
});

describe('WeightBar', () => {
  it('renderiza label, percentual arredondado e largura proporcional', () => {
    const { container } = render(<WeightBar label="RF (Recência)" value={42.7} />);
    expect(screen.getByText('RF (Recência)')).toBeTruthy();
    expect(screen.getByText('43%')).toBeTruthy();
    const bar = container.querySelector<HTMLElement>('div[style]');
    expect(bar?.style.width).toBe('42.7%');
  });

  it('aceita cor customizada', () => {
    const { container } = render(<WeightBar label="X" value={10} color="bg-destructive" />);
    expect(container.querySelector('.bg-destructive')).toBeTruthy();
  });
});

describe('TabSkeleton', () => {
  it('renderiza 3 skeletons', () => {
    const { container } = render(<TabSkeleton />);
    // shadcn Skeleton aplica a classe animate-shimmer
    expect(container.querySelectorAll('.animate-shimmer').length).toBe(3);
  });
});
