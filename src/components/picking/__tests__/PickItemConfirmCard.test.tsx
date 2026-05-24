import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PickItemConfirmCard, type PickItem } from '../PickItemConfirmCard';

const item: PickItem = {
  id: 'item-1',
  product_descricao: 'Lixa 120',
  quantidade: 10,
  quantidade_separada: 0,
  status: 'pendente',
  lote_fefo: 'LOTE-A',
  lote_separado: null,
};

describe('PickItemConfirmCard', () => {
  it('confirma cheio com lote FEFO no caminho rápido', () => {
    const onConfirm = vi.fn();
    render(<PickItemConfirmCard item={item} pending={false} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: /confirmar separação/i }));
    expect(onConfirm).toHaveBeenCalledWith({
      quantidadeSeparada: 10,
      loteInformado: 'LOTE-A',
      justificativa: null,
    });
  });

  it('na divergência de lote, exige justificativa pra habilitar o confirmar', () => {
    const onConfirm = vi.fn();
    render(<PickItemConfirmCard item={item} pending={false} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: /divergência/i }));

    // Muda o lote pra um diferente do FEFO → vira divergência
    fireEvent.change(screen.getByLabelText(/lote separado/i), { target: { value: 'LOTE-B' } });

    const confirmDiv = screen.getByRole('button', { name: /confirmar com divergência/i });
    expect(confirmDiv).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/justificativa/i), { target: { value: 'lote A esgotado' } });
    expect(confirmDiv).toBeEnabled();

    fireEvent.click(confirmDiv);
    expect(onConfirm).toHaveBeenCalledWith({
      quantidadeSeparada: 10,
      loteInformado: 'LOTE-B',
      justificativa: 'lote A esgotado',
    });
  });

  it('mostra badge pendente quando pending=true', () => {
    render(<PickItemConfirmCard item={item} pending onConfirm={vi.fn()} />);
    expect(screen.getByText(/pendente sync/i)).toBeInTheDocument();
  });
});
