import { describe, it, expect, vi } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AIInputArea } from '../AIInputArea';

function setup(overrides: Partial<React.ComponentProps<typeof AIInputArea>> = {}) {
  const props: React.ComponentProps<typeof AIInputArea> = {
    fileInputRef: createRef<HTMLInputElement>(),
    audioInputRef: createRef<HTMLInputElement>(),
    onImageSelect: vi.fn(),
    onAudioFileSelect: vi.fn(),
    images: [],
    onRemoveImage: vi.fn(),
    text: '',
    onTextChange: vi.fn(),
    isRecording: false,
    isTranscribing: false,
    isAnalyzing: false,
    isLoading: false,
    isProcessing: false,
    recordingDuration: 0,
    onStartRecording: vi.fn(),
    onStopRecording: vi.fn(),
    onAnalyze: vi.fn(),
    hasCustomerSelected: false,
    ...overrides,
  };
  render(<AIInputArea {...props} />);
  return props;
}

describe('AIInputArea', () => {
  it('rotula o botão analisar para "Identificar Cliente e Itens" sem cliente', () => {
    setup({ hasCustomerSelected: false });
    expect(screen.getByRole('button', { name: /Identificar Cliente e Itens/ })).toBeTruthy();
  });

  it('rotula o botão analisar para "Identificar Itens do Pedido" com cliente', () => {
    setup({ hasCustomerSelected: true });
    expect(screen.getByRole('button', { name: /Identificar Itens do Pedido/ })).toBeTruthy();
  });

  it('dispara onTextChange ao digitar', () => {
    const props = setup();
    const ta = screen.getByPlaceholderText(/Pedido do cliente/);
    fireEvent.change(ta, { target: { value: '10 discos' } });
    expect(props.onTextChange).toHaveBeenCalledWith('10 discos');
  });

  it('dispara onAnalyze ao clicar quando há texto', () => {
    const props = setup({ text: '10 discos' });
    fireEvent.click(screen.getByRole('button', { name: /Identificar/ }));
    expect(props.onAnalyze).toHaveBeenCalledTimes(1);
  });

  it('botão de microfone inicia gravação', () => {
    const props = setup();
    fireEvent.click(screen.getByTitle('Gravar áudio'));
    expect(props.onStartRecording).toHaveBeenCalledTimes(1);
  });

  it('quando gravando, mostra duração e botão para parar', () => {
    const props = setup({ isRecording: true, recordingDuration: 65 });
    expect(screen.getByText(/Gravando\.\.\. 1:05/)).toBeTruthy();
    fireEvent.click(screen.getByTitle('Parar gravação'));
    expect(props.onStopRecording).toHaveBeenCalledTimes(1);
  });

  it('mostra indicador de transcrição', () => {
    setup({ isTranscribing: true });
    expect(screen.getByText('Transcrevendo áudio...')).toBeTruthy();
  });
});
