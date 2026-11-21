import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RestoreDraftDialog } from '@/components/unified-order/RestoreDraftDialog';

// Ciclo ÚNICO envelope × rascunho (follow-up Codex do #4042): descartar com envio pendente
// pede confirmação explícita — o descarte zera o envelope e o próximo pedido vira NOVO.
function montar(envioPendente: boolean) {
  const onDiscard = vi.fn();
  const onRestore = vi.fn();
  render(
    <RestoreDraftDialog open savedAt={new Date().toISOString()} customerName="ACME" itemCount={2}
      onRestore={onRestore} onDiscard={onDiscard} envioPendente={envioPendente} />,
  );
  return { onDiscard, onRestore };
}

describe('RestoreDraftDialog — descarte com envio pendente', () => {
  it('sem envio pendente: Descartar descarta direto', () => {
    const { onDiscard } = montar(false);
    fireEvent.click(screen.getByRole('button', { name: /Descartar/ }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('com envio pendente: Descartar NÃO descarta; pede confirmação', () => {
    const { onDiscard } = montar(true);
    fireEvent.click(screen.getByRole('button', { name: /Descartar/ }));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(screen.getByText('Há um envio pendente para este pedido')).toBeTruthy();
  });

  it('com envio pendente: "Descartar mesmo assim" descarta; "Voltar" não', () => {
    const { onDiscard } = montar(true);
    fireEvent.click(screen.getByRole('button', { name: /Descartar/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(onDiscard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Descartar/ }));
    fireEvent.click(screen.getByRole('button', { name: /Descartar mesmo assim/ }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
