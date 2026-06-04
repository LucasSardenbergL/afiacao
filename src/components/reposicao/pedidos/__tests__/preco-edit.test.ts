import { describe, it, expect } from 'vitest';
import { montarUpdateItem, podeEditarPrecoPedido, precoEditavelDaLinha, precoEditValido } from '../preco-edit';

describe('preco-edit — gating por status do pedido', () => {
  it('permite editar preço em falha_envio, pendente_aprovacao e bloqueado_guardrail', () => {
    expect(podeEditarPrecoPedido('falha_envio')).toBe(true);
    expect(podeEditarPrecoPedido('pendente_aprovacao')).toBe(true);
    expect(podeEditarPrecoPedido('bloqueado_guardrail')).toBe(true);
  });
  it('NÃO permite em estados já disparados/aprovados/cancelados nem em null/undefined', () => {
    expect(podeEditarPrecoPedido('disparado')).toBe(false);
    expect(podeEditarPrecoPedido('aprovado_aguardando_disparo')).toBe(false);
    expect(podeEditarPrecoPedido('cancelado')).toBe(false);
    expect(podeEditarPrecoPedido(null)).toBe(false);
    expect(podeEditarPrecoPedido(undefined)).toBe(false);
  });
});

describe('preco-edit — qual item ganha input', () => {
  it('só item SEM custo (preço <= 0 / null) quando o pedido permite', () => {
    expect(precoEditavelDaLinha(true, { preco_unitario: 0 })).toBe(true);
    expect(precoEditavelDaLinha(true, { preco_unitario: null })).toBe(true);
    expect(precoEditavelDaLinha(true, { preco_unitario: -1 })).toBe(true);
  });
  it('item com custo válido fica read-only (não editável)', () => {
    expect(precoEditavelDaLinha(true, { preco_unitario: 25.35 })).toBe(false);
    expect(precoEditavelDaLinha(true, { preco_unitario: 0.01 })).toBe(false);
  });
  it('nunca editável quando o pedido não permite, mesmo com preço 0', () => {
    expect(precoEditavelDaLinha(false, { preco_unitario: 0 })).toBe(false);
  });
});

describe('preco-edit — validação money-path (nunca gravar preço <= 0)', () => {
  it('aceita só valor finito e > 0', () => {
    expect(precoEditValido(25.35)).toBe(true);
    expect(precoEditValido(113.98)).toBe(true);
  });
  it('rejeita 0, negativo, NaN e Infinity', () => {
    expect(precoEditValido(0)).toBe(false);
    expect(precoEditValido(-5)).toBe(false);
    expect(precoEditValido(NaN)).toBe(false);
    expect(precoEditValido(Infinity)).toBe(false);
  });
});

describe('preco-edit — montarUpdateItem (money-path: não reescrever preço válido)', () => {
  const item = { qtde_final: 5, qtde_sugerida: 8, preco_unitario: 20 };

  it('quantity-only: NÃO inclui preco_unitario (preserva o preço válido)', () => {
    const u = montarUpdateItem(item, 7, undefined);
    expect(u.qtde_final).toBe(7);
    expect(u.valor_linha).toBe(7 * 20);
    expect('preco_unitario' in u).toBe(false);
  });

  it('price-only: inclui preco_unitario e preserva a quantidade atual', () => {
    const u = montarUpdateItem({ ...item, preco_unitario: 0 }, undefined, 25.35);
    expect(u.qtde_final).toBe(5);
    expect(u.preco_unitario).toBe(25.35);
    expect(u.valor_linha).toBeCloseTo(5 * 25.35);
  });

  it('ambos (qtde + preço): inclui preço novo e quantidade nova', () => {
    const u = montarUpdateItem({ ...item, preco_unitario: 0 }, 3, 25.35);
    expect(u.qtde_final).toBe(3);
    expect(u.preco_unitario).toBe(25.35);
    expect(u.valor_linha).toBeCloseTo(3 * 25.35);
  });

  it('price-only com qtde_final null usa qtde_sugerida', () => {
    const u = montarUpdateItem({ qtde_final: null, qtde_sugerida: 8, preco_unitario: 0 }, undefined, 25.35);
    expect(u.qtde_final).toBe(8);
    expect(u.preco_unitario).toBe(25.35);
  });
});
