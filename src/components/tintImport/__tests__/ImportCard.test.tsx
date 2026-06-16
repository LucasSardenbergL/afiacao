import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImportCard } from '../ImportCard';
import type { FileWithPreview, TintImportFileResult } from '../types';

const fileFix: FileWithPreview = {
  file: new File(['a;b\n1;2'], 'teste.csv', { type: 'text/csv' }),
  preview: [['Col A', 'Col B'], ['1', '2']],
  name: 'teste.csv',
  rawText: 'a;b\n1;2',
};

function noop() { /* */ }

function baseProps(over: Partial<React.ComponentProps<typeof ImportCard>> = {}): React.ComponentProps<typeof ImportCard> {
  return {
    tipo: '',
    setTipo: noop,
    importMode: 'auto',
    setImportMode: noop,
    files: [],
    onFiles: noop,
    importing: false,
    directRunning: false,
    directProgress: null,
    chunkProgress: { currentFile: 0, totalFiles: 0, fileName: '', currentChunk: 0, totalChunks: 0 },
    progressPct: 0,
    results: [],
    onImport: noop,
    onCancelDirect: noop,
    ...over,
  };
}

describe('ImportCard', () => {
  it('sem tipo/arquivos → botão Importar desabilitado', () => {
    render(<ImportCard {...baseProps()} />);
    expect((screen.getByRole('button', { name: /Importar/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('com tipo e arquivo → preview, contador de linhas e Importar habilitado dispara onImport', () => {
    const onImport = vi.fn();
    render(<ImportCard {...baseProps({ tipo: 'dados_corantes', files: [fileFix], onImport })} />);
    expect(screen.getByText('teste.csv')).toBeTruthy();
    expect(screen.getByText('Col A')).toBeTruthy();
    expect(screen.getByText(/1 linhas/)).toBeTruthy();
    const btn = screen.getByRole('button', { name: /Importar/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onImport).toHaveBeenCalled();
  });

  it('mostra resultados de importação', () => {
    const results: TintImportFileResult[] = [
      { name: 'teste.csv', status: 'concluido', registros_importados: 10, registros_atualizados: 3, registros_erro: 0 },
    ];
    render(<ImportCard {...baseProps({ results })} />);
    expect(screen.getByText('Resultado')).toBeTruthy();
    expect(screen.getByText(/10 importados, 3 atualizados, 0 erros/)).toBeTruthy();
  });
});
