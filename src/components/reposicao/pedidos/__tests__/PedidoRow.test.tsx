import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PedidoRow } from '../PedidoRow';
import type { PedidoSugerido } from '../types';

function ped(partial: Partial<PedidoSugerido>): PedidoSugerido {
  return partial as unknown as PedidoSugerido;
}

function renderRow(p: PedidoSugerido) {
  const onDisparar = vi.fn();
  const utils = render(
    <table>
      <tbody>
        <PedidoRow
          p={p}
          onVerDetalhes={() => {}}
          onCancelar={() => {}}
          onVerPortal={() => {}}
          onDisparar={onDisparar}
          disparando={false}
        />
      </tbody>
    </table>,
  );
  return { onDisparar, ...utils };
}

describe('PedidoRow — re-disparo de falha_envio', () => {
  it('mostra "Re-disparar" e chama onDisparar quando status é falha_envio', () => {
    const { onDisparar } = renderRow(
      ped({ id: 1, status: 'falha_envio', fornecedor_nome: 'RENNER SAYERLACK S/A', num_skus: 18, valor_total: 7716.34 }),
    );
    const btn = screen.getByRole('button', { name: /Re-disparar/i });
    fireEvent.click(btn);
    expect(onDisparar).toHaveBeenCalledTimes(1);
  });

  it('mostra "Disparar" (não "Re-disparar") quando status é aprovado_aguardando_disparo', () => {
    renderRow(ped({ id: 2, status: 'aprovado_aguardando_disparo', fornecedor_nome: 'X', num_skus: 3, valor_total: 50 }));
    expect(screen.getByRole('button', { name: /^Disparar$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Re-disparar/i })).toBeNull();
  });

  it('não mostra botão de disparo quando status é disparado', () => {
    renderRow(
      ped({ id: 3, status: 'disparado', fornecedor_nome: 'X', num_skus: 3, valor_total: 50, omie_pedido_compra_numero: '123' }),
    );
    expect(screen.queryByRole('button', { name: /disparar/i })).toBeNull();
  });
});
