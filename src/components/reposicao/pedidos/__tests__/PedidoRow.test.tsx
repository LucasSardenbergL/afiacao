import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PedidoRow } from '../PedidoRow';
import type { PedidoSugerido } from '../types';

function ped(partial: Partial<PedidoSugerido>): PedidoSugerido {
  return partial as unknown as PedidoSugerido;
}

function renderRow(
  p: PedidoSugerido,
  opts?: { onDispararIgnorandoMinimo?: () => void },
) {
  const onDisparar = vi.fn();
  const onOverride = opts?.onDispararIgnorandoMinimo;
  const utils = render(
    <table>
      <tbody>
        <PedidoRow
          p={p}
          onVerDetalhes={() => {}}
          onCancelar={() => {}}
          onVerPortal={() => {}}
          onDisparar={onDisparar}
          onDispararIgnorandoMinimo={onOverride}
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

describe('PedidoRow — tooltip de motivo (bloqueio / falha)', () => {
  it('bloqueado_guardrail com mensagem_bloqueio → mostra o ícone de motivo do bloqueio', () => {
    renderRow(
      ped({
        id: 10,
        status: 'bloqueado_guardrail',
        fornecedor_nome: 'X',
        num_skus: 5,
        valor_total: 999,
        mensagem_bloqueio: 'Variação acima de 50% vs ciclo anterior',
      }),
    );
    expect(screen.getByRole('button', { name: /Motivo do bloqueio/i })).toBeTruthy();
  });

  it('bloqueado_guardrail SEM mensagem_bloqueio → não renderiza o ícone (guard de null)', () => {
    renderRow(
      ped({ id: 11, status: 'bloqueado_guardrail', fornecedor_nome: 'X', num_skus: 5, valor_total: 999, mensagem_bloqueio: null }),
    );
    expect(screen.queryByRole('button', { name: /Motivo do bloqueio/i })).toBeNull();
  });

  it('falha_envio com resposta_canal.erro → mostra o ícone de motivo da falha', () => {
    renderRow(
      ped({
        id: 12,
        status: 'falha_envio',
        fornecedor_nome: 'RENNER SAYERLACK S/A',
        num_skus: 18,
        valor_total: 7716.34,
        resposta_canal: { erro: 'SKU(s) sem custo (preço unitário 0)' },
      }),
    );
    expect(screen.getByRole('button', { name: /Motivo da falha no disparo/i })).toBeTruthy();
  });

  it('falha_envio SEM resposta_canal.erro → não renderiza o ícone (guard de null)', () => {
    renderRow(
      ped({ id: 13, status: 'falha_envio', fornecedor_nome: 'X', num_skus: 18, valor_total: 50, resposta_canal: null }),
    );
    expect(screen.queryByRole('button', { name: /Motivo da falha no disparo/i })).toBeNull();
  });

  it('status normal → nenhum ícone de motivo', () => {
    renderRow(ped({ id: 14, status: 'aprovado_aguardando_disparo', fornecedor_nome: 'X', num_skus: 3, valor_total: 50 }));
    expect(screen.queryByRole('button', { name: /Motivo/i })).toBeNull();
  });
});

describe('PedidoRow — override do mínimo de faturamento ("Disparar mesmo assim")', () => {
  const gateMin = (over?: () => void) =>
    renderRow(
      ped({
        id: 20,
        status: 'falha_envio',
        fornecedor_nome: 'RENNER SAYERLACK S/A',
        num_skus: 4,
        valor_total: 1800,
        resposta_canal: { erro: 'abaixo do mínimo de faturamento', gate: 'minimo_faturamento' },
      }),
      over ? { onDispararIgnorandoMinimo: over } : undefined,
    );

  it('gate-min + gestor (callback): mostra "Disparar mesmo assim" no lugar de "Re-disparar"', () => {
    gateMin(vi.fn());
    expect(screen.getByRole('button', { name: /Disparar mesmo assim/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Re-disparar/i })).toBeNull();
  });

  it('gate-min SEM callback (não-gestor): cai no "Re-disparar" normal, sem override', () => {
    gateMin(undefined);
    expect(screen.getByRole('button', { name: /Re-disparar/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Disparar mesmo assim/i })).toBeNull();
  });

  it('falha_envio por OUTRO motivo + callback: NÃO oferece override (só "Re-disparar")', () => {
    renderRow(
      ped({
        id: 21,
        status: 'falha_envio',
        fornecedor_nome: 'RENNER SAYERLACK S/A',
        num_skus: 4,
        valor_total: 1800,
        resposta_canal: { erro: 'SKU(s) sem custo (preço unitário 0)' },
      }),
      { onDispararIgnorandoMinimo: vi.fn() },
    );
    expect(screen.getByRole('button', { name: /Re-disparar/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Disparar mesmo assim/i })).toBeNull();
  });

  it('confirmar no diálogo chama onDispararIgnorandoMinimo uma vez', () => {
    const over = vi.fn();
    gateMin(over);
    fireEvent.click(screen.getByRole('button', { name: /Disparar mesmo assim/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirmar e disparar/i }));
    expect(over).toHaveBeenCalledTimes(1);
  });
});
