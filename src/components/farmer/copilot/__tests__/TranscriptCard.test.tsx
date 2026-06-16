import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createRef as reactCreateRef } from 'react';
import { TranscriptCard } from '../TranscriptCard';
import type { TranscriptEntry } from '@/hooks/useCopilotEngine';

describe('TranscriptCard', () => {
  it('mostra placeholder de voz quando vazio', () => {
    render(<TranscriptCard transcript={[]} inputMode="voice" transcriptEndRef={reactCreateRef()} />);
    expect(screen.getByText('Aguardando fala...')).toBeTruthy();
  });

  it('mostra placeholder de texto quando vazio', () => {
    render(<TranscriptCard transcript={[]} inputMode="text" transcriptEndRef={reactCreateRef()} />);
    expect(screen.getByText('Nenhum texto analisado ainda.')).toBeTruthy();
  });

  it('renderiza as entradas da transcrição', () => {
    const transcript = [
      { id: '1', text: 'olá', isPartial: false },
      { id: '2', text: 'parcial', isPartial: true },
    ] as unknown as TranscriptEntry[];
    render(<TranscriptCard transcript={transcript} inputMode="voice" transcriptEndRef={reactCreateRef()} />);
    expect(screen.getByText('olá')).toBeTruthy();
    expect(screen.getByText('parcial')).toBeTruthy();
  });
});
