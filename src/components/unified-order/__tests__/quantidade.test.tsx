import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { confirmarQuantidade, digitosDaQuantidade } from '../quantidade';
import { QuantidadeInput } from '../QuantidadeInput';

describe('confirmarQuantidade — vazio/inválido volta ao anterior', () => {
  it.each<[string, number, number]>([
    ['12', 3, 12],
    [' 7 ', 3, 7],
    ['', 3, 3],
    ['0', 3, 3],
    ['00', 3, 3],
    ['abc', 3, 3],
    ['1.5', 3, 3],
    ['-2', 3, 3],
    ['99999999999999999999', 3, 3],
  ])('"%s" com anterior %i → %i', (texto, anterior, esperado) => {
    expect(confirmarQuantidade(texto, anterior)).toBe(esperado);
  });

  it('digitosDaQuantidade tira o que não é dígito', () => {
    expect(digitosDaQuantidade('1a2-')).toBe('12');
    expect(digitosDaQuantidade('')).toBe('');
  });
});

/** Espelha o carrinho: o pai guarda a quantidade e recebe DELTA (como updateQuantity). */
function Carrinho({ inicial, onDelta }: { inicial: number; onDelta: (d: number) => void }) {
  const [qtd, setQtd] = useState(inicial);
  return (
    <QuantidadeInput
      value={qtd}
      aria-label="Quantidade"
      onCommit={nova => { onDelta(nova - qtd); setQtd(nova); }}
    />
  );
}
const campo = () => screen.getByRole('textbox', { name: 'Quantidade' }) as HTMLInputElement;

describe('QuantidadeInput — buffer local até blur/Enter', () => {
  it('apagar tudo e digitar 12: nada vai ao carrinho no meio; no blur vai +9 de uma vez', () => {
    const onDelta = vi.fn();
    render(<Carrinho inicial={3} onDelta={onDelta} />);
    fireEvent.focus(campo());
    fireEvent.change(campo(), { target: { value: '' } });
    expect(campo().value).toBe('');
    fireEvent.change(campo(), { target: { value: '1' } });
    fireEvent.change(campo(), { target: { value: '12' } });
    expect(onDelta).not.toHaveBeenCalled();
    fireEvent.blur(campo());
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledWith(9);
    expect(campo().value).toBe('12');
  });

  it('vazio no blur volta ao anterior e não chama o carrinho (nunca 0)', () => {
    const onDelta = vi.fn();
    render(<Carrinho inicial={4} onDelta={onDelta} />);
    fireEvent.focus(campo());
    fireEvent.change(campo(), { target: { value: '' } });
    fireEvent.blur(campo());
    expect(onDelta).not.toHaveBeenCalled();
    expect(campo().value).toBe('4');
  });

  it('Enter confirma UMA vez só (o blur do Enter não duplica o delta)', () => {
    const onDelta = vi.fn();
    render(<Carrinho inicial={2} onDelta={onDelta} />);
    campo().focus();
    fireEvent.focus(campo());
    fireEvent.change(campo(), { target: { value: '5' } });
    fireEvent.keyDown(campo(), { key: 'Enter' });
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledWith(3);
  });

  it('Esc descarta a edição', () => {
    const onDelta = vi.fn();
    render(<Carrinho inicial={2} onDelta={onDelta} />);
    campo().focus();
    fireEvent.focus(campo());
    fireEvent.change(campo(), { target: { value: '50' } });
    fireEvent.keyDown(campo(), { key: 'Escape' });
    expect(onDelta).not.toHaveBeenCalled();
    expect(campo().value).toBe('2');
  });

  it('letras digitadas não entram no buffer', () => {
    render(<Carrinho inicial={2} onDelta={vi.fn()} />);
    fireEvent.focus(campo());
    fireEvent.change(campo(), { target: { value: '3x' } });
    expect(campo().value).toBe('3');
  });
});
