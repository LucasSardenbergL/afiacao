import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TodayStatsCards } from '../TodayStatsCards';

describe('TodayStatsCards', () => {
  it('renderiza contagem, receita formatada e duração média', () => {
    render(<TodayStatsCards count={7} revenue={1500} avgDuration={125} />);
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('Ligações hoje')).toBeTruthy();
    expect(screen.getByText(/1\.500,00/)).toBeTruthy();
    expect(screen.getByText('02:05')).toBeTruthy();
    expect(screen.getByText('Duração média')).toBeTruthy();
  });
});
