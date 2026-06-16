import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SyncCard } from '../SyncCard';

describe('SyncCard', () => {
  it('renderiza e o botão dispara onSync', () => {
    const onSync = vi.fn();
    render(<SyncCard syncing={false} onSync={onSync} />);
    fireEvent.click(screen.getByRole('button', { name: /Sincronizar Produtos Omie/ }));
    expect(onSync).toHaveBeenCalled();
  });

  it('mostra contagens quando há produtos', () => {
    render(<SyncCard syncing={false} onSync={() => {}} tintCounts={{ bases: 4, concentrados: 9 }} />);
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('9')).toBeTruthy();
  });

  it('botão desabilitado quando syncing', () => {
    render(<SyncCard syncing onSync={() => {}} />);
    expect((screen.getByRole('button', { name: /Sincronizar/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
