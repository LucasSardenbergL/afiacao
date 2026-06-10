import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DialPad } from '../DialPad';

// Política do founder (2026-06-09): gravação OBRIGATÓRIA na Central de Telefonia.
// O switch existe só como exceção ("cliente pediu pra não gravar") e re-arma a
// cada chamada — o opt-out de uma ligação não pode vazar pra seguinte.
describe('DialPad — gravação obrigatória por default', () => {
  function setup() {
    const onCall = vi.fn();
    render(<DialPad onCall={onCall} backend="webrtc" />);
    const input = screen.getByPlaceholderText('número');
    fireEvent.change(input, { target: { value: '37999998888' } });
    return { onCall };
  }

  it('switch de gravação nasce LIGADO', () => {
    const onCall = vi.fn();
    render(<DialPad onCall={onCall} backend="webrtc" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('ligar com o default envia forceRecord: true', () => {
    const { onCall } = setup();
    fireEvent.click(screen.getByRole('button', { name: /^ligar para/i }));
    expect(onCall).toHaveBeenCalledWith('37999998888', { forceRecord: true });
  });

  it('exceção: cliente pediu pra não gravar → desliga o switch → forceRecord: false', () => {
    const { onCall } = setup();
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: /^ligar para/i }));
    expect(onCall).toHaveBeenCalledWith('37999998888', { forceRecord: false });
  });

  it('re-arma: após discar com gravação desligada, o switch volta a LIGADO', () => {
    const { onCall } = setup();
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: /^ligar para/i }));
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });
});
