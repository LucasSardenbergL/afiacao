import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PriceInput } from '../PriceInput';

describe('PriceInput', () => {
  it('propaga o número parseado da vírgula decimal (12,5 → 12.5, não 125)', () => {
    const onValueChange = vi.fn();
    render(<PriceInput value={0} onValueChange={onValueChange} aria-label="preco" />);
    fireEvent.change(screen.getByLabelText('preco'), { target: { value: '12,5' } });
    expect(onValueChange).toHaveBeenLastCalledWith(12.5);
  });

  it('preserva o texto digitado quando o value controlado muda no re-render (o buffer que impede o descarte da vírgula)', () => {
    const { rerender } = render(
      <PriceInput value={0} onValueChange={() => {}} aria-label="preco" />,
    );
    const input = screen.getByLabelText('preco') as HTMLInputElement;
    fireEvent.focus(input);
    // vírgula parcial ("12,") ainda não parseia — não deve propagar nem sumir do campo
    fireEvent.change(input, { target: { value: '12,' } });
    rerender(<PriceInput value={99} onValueChange={() => {}} aria-label="preco" />);
    expect(input.value).toBe('12,'); // não virou "99" (controlado) nem "12" (vírgula descartada)
  });

  it('não propaga valor para entrada ilegível (não fabrica zero)', () => {
    const onValueChange = vi.fn();
    render(<PriceInput value={10} onValueChange={onValueChange} aria-label="preco" />);
    fireEvent.change(screen.getByLabelText('preco'), { target: { value: 'abc' } });
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
