import { describe, it, expect } from 'vitest';
import { classificarEstadoVenda, type DisponibilidadeInput } from '../resolver-estado';

const base: DisponibilidadeInput = {
  temSkuConfirmado: true,
  baseEmEstoque: true,
  precisaCatalisador: true,
  catalisadorMapeado: true,
  catalisadorEmEstoque: true,
  precoOk: true,
};

describe('classificarEstadoVenda (regras confirmadas pelo founder + Codex)', () => {
  it('sem SKU confirmado → TECHNICAL_ONLY (sob consulta), independente do resto', () => {
    expect(classificarEstadoVenda({ ...base, temSkuConfirmado: false })).toBe('TECHNICAL_ONLY');
    // mesmo com tudo "disponível", sem casamento não há produto vendável
    expect(classificarEstadoVenda({ ...base, temSkuConfirmado: false, baseEmEstoque: true })).toBe('TECHNICAL_ONLY');
  });

  it('base + catalisador em estoque + precificado → SELLABLE_NOW', () => {
    expect(classificarEstadoVenda(base)).toBe('SELLABLE_NOW');
  });

  it('produto 1-componente (não precisa catalisador): base em estoque + preço → SELLABLE_NOW', () => {
    expect(classificarEstadoVenda({ ...base, precisaCatalisador: false, catalisadorMapeado: false, catalisadorEmEstoque: false })).toBe('SELLABLE_NOW');
  });

  it('🔴 precisa catalisador mas ele NÃO está em estoque → ORDERABLE (não promete "em estoque")', () => {
    expect(classificarEstadoVenda({ ...base, catalisadorEmEstoque: false })).toBe('ORDERABLE');
  });

  it('precisa catalisador mas ele não está mapeado (sem SKU) → ORDERABLE', () => {
    expect(classificarEstadoVenda({ ...base, catalisadorMapeado: false })).toBe('ORDERABLE');
  });

  it('base fora de estoque → ORDERABLE (mesmo com catalisador disponível)', () => {
    expect(classificarEstadoVenda({ ...base, baseEmEstoque: false })).toBe('ORDERABLE');
  });

  it('🔴 tudo disponível mas preço incompleto (sob consulta) → ORDERABLE, NUNCA SELLABLE_NOW', () => {
    // Codex: SELLABLE_NOW exige PRECIFICADO. Sem preço confiável não é "em estoque, pode vender já".
    expect(classificarEstadoVenda({ ...base, precoOk: false })).toBe('ORDERABLE');
  });
});
