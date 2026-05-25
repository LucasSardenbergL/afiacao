import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ManualTextInput } from '../ManualTextInput';

function setup(overrides: Partial<React.ComponentProps<typeof ManualTextInput>> = {}) {
  const props: React.ComponentProps<typeof ManualTextInput> = {
    manualText: '',
    setManualText: vi.fn(),
    isManualAnalyzing: false,
    onAnalyze: vi.fn(),
    ...overrides,
  };
  render(<ManualTextInput {...props} />);
  return props;
}

describe('ManualTextInput', () => {
  it('dispara setManualText ao digitar', () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText(/Cole ou digite/), { target: { value: 'oi' } });
    expect(props.setManualText).toHaveBeenCalledWith('oi');
  });

  it('botão Analisar desabilitado sem texto', () => {
    setup({ manualText: '' });
    expect(screen.getByRole('button', { name: /Analisar/ })).toHaveProperty('disabled', true);
  });

  it('dispara onAnalyze com texto presente', () => {
    const props = setup({ manualText: 'conversa longa' });
    fireEvent.click(screen.getByRole('button', { name: /Analisar/ }));
    expect(props.onAnalyze).toHaveBeenCalledTimes(1);
  });
});
