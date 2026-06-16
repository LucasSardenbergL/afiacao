import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrendingUp } from 'lucide-react';
import { DirectionIndicator } from '../DirectionIndicator';
import { directionConfig } from '../config';
import type { CopilotAnalysis } from '@/hooks/useCopilotEngine';

function analysis(p: Partial<CopilotAnalysis>): CopilotAnalysis {
  return {
    direction: 'positivo',
    directionReasons: ['cliente engajado', 'pediu preço'],
    intent: 'interesse',
    phase: 'diagnostico',
    suggestionType: 'argumento_economico',
    suggestion: 's',
    confidence: 80,
    ...p,
  } as CopilotAnalysis;
}

describe('DirectionIndicator', () => {
  it('mostra label da direção, intenção, fase e motivos', () => {
    render(
      <DirectionIndicator
        analysis={analysis({})}
        dir={directionConfig.positivo}
        DirIcon={TrendingUp}
      />,
    );
    expect(screen.getByText('Positivo')).toBeTruthy();
    expect(screen.getByText('Interesse')).toBeTruthy();
    expect(screen.getByText(/Diagnóstico/)).toBeTruthy();
    expect(screen.getByText(/cliente engajado/)).toBeTruthy();
  });

  it('usa o label cru quando intent é desconhecido', () => {
    render(
      <DirectionIndicator
        analysis={analysis({ intent: 'xpto' as CopilotAnalysis['intent'], directionReasons: [] })}
        dir={directionConfig.positivo}
        DirIcon={TrendingUp}
      />,
    );
    expect(screen.getByText('xpto')).toBeTruthy();
  });
});
