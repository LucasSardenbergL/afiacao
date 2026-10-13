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

  describe('confirmarAoSair (linha com cor, Fase 2B)', () => {
    it('não propaga a cada tecla; propaga UMA vez ao sair, com o valor final', () => {
      const onValueChange = vi.fn();
      render(<PriceInput value={120} onValueChange={onValueChange} confirmarAoSair aria-label="preco" />);
      const input = screen.getByLabelText('preco');
      fireEvent.focus(input);
      for (const t of ['1', '13', '130']) fireEvent.change(input, { target: { value: t } });
      expect(onValueChange).not.toHaveBeenCalled();
      fireEvent.blur(input);
      expect(onValueChange).toHaveBeenCalledTimes(1);
      expect(onValueChange).toHaveBeenCalledWith(130);
    });

    it('Enter confirma', () => {
      const onValueChange = vi.fn();
      render(<PriceInput value={120} onValueChange={onValueChange} confirmarAoSair aria-label="preco" />);
      const input = screen.getByLabelText('preco');
      input.focus();
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '99,9' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onValueChange).toHaveBeenCalledWith(99.9);
    });

    it('focar e sair SEM mudar o texto não propaga (o % exibido arredondado não regrava o exato)', () => {
      const onValueChange = vi.fn();
      render(<PriceInput value={7.142857} formatar={(v) => v.toFixed(2).replace('.', ',')} onValueChange={onValueChange} confirmarAoSair aria-label="pct" />);
      const input = screen.getByLabelText('pct') as HTMLInputElement;
      expect(input.value).toBe('7,14');
      fireEvent.focus(input);
      fireEvent.blur(input);
      expect(onValueChange).not.toHaveBeenCalled();
    });

    it('recusado pelo dono: ao sair, o campo volta ao valor vigente', () => {
      render(<PriceInput value={120} onValueChange={() => {}} confirmarAoSair aria-label="preco" />);
      const input = screen.getByLabelText('preco') as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '130' } });
      fireEvent.blur(input);
      expect(input.value).toBe('120');
    });
  });
});
