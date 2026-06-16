import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Lightbulb } from 'lucide-react';
import { SuggestionCard } from '../SuggestionCard';
import type { CopilotAnalysis } from '@/hooks/useCopilotEngine';

function analysis(p: Partial<CopilotAnalysis>): CopilotAnalysis {
  return {
    direction: 'positivo',
    directionReasons: [],
    intent: 'interesse',
    phase: 'abertura',
    suggestionType: 'argumento_economico',
    suggestion: 'Mostre o ROI do produto premium.',
    confidence: 82,
    ...p,
  } as CopilotAnalysis;
}

describe('SuggestionCard', () => {
  it('renderiza tipo da sugestão, texto e confiança', () => {
    render(
      <SuggestionCard
        analysis={analysis({})}
        SugIcon={Lightbulb}
        riskFlash={false}
        copied={false}
        onCopy={vi.fn()}
        suggestionsShown={3}
        suggestionsUsed={1}
      />,
    );
    expect(screen.getByText('Argumento Econômico')).toBeTruthy();
    expect(screen.getByText('Mostre o ROI do produto premium.')).toBeTruthy();
    expect(screen.getByText(/Confiança: 82%/)).toBeTruthy();
    expect(screen.getByText(/3 sugestões • 1 usadas/)).toBeTruthy();
  });

  it('copia a sugestão ao clicar', () => {
    const onCopy = vi.fn();
    render(
      <SuggestionCard
        analysis={analysis({ suggestion: 'X' })}
        SugIcon={Lightbulb}
        riskFlash={false}
        copied={false}
        onCopy={onCopy}
        suggestionsShown={0}
        suggestionsUsed={0}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onCopy).toHaveBeenCalledWith('X');
  });

  it('mostra rótulo de pergunta diagnóstica', () => {
    render(
      <SuggestionCard
        analysis={analysis({ suggestionType: 'pergunta_diagnostica' })}
        SugIcon={Lightbulb}
        riskFlash={false}
        copied={false}
        onCopy={vi.fn()}
        suggestionsShown={0}
        suggestionsUsed={0}
      />,
    );
    expect(screen.getByText('Pergunta Sugerida')).toBeTruthy();
  });
});
