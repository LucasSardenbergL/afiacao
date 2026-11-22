import { describe, it, expect } from 'vitest';
import {
  subtotalServicosParaExibicao,
  missingAccountIdentities,
  isValidOmieClientCode,
  omieAccountIdentityMissingMessage,
} from '../helpers';

describe('missingAccountIdentities (preflight fail-closed)', () => {
  it('todas as contas com itens têm código → vazio', () => {
    expect(missingAccountIdentities({
      hasOben: true, hasColacor: true, hasAfiacao: true,
      codigoCliente: 100, codigoClienteColacor: 200, codigoClienteAfiacao: 300,
    })).toEqual([]);
  });

  it('Colacor com itens sem código → Colacor faltando', () => {
    expect(missingAccountIdentities({
      hasOben: false, hasColacor: true, hasAfiacao: false,
      codigoCliente: 100, codigoClienteColacor: null, codigoClienteAfiacao: null,
    })).toEqual(['Colacor']);
  });

  it('Afiação com serviços sem código → Afiação faltando', () => {
    expect(missingAccountIdentities({
      hasOben: false, hasColacor: false, hasAfiacao: true,
      codigoCliente: 100, codigoClienteColacor: null, codigoClienteAfiacao: undefined,
    })).toEqual(['Afiação']);
  });

  it('Oben com itens sem código → Oben faltando', () => {
    expect(missingAccountIdentities({
      hasOben: true, hasColacor: false, hasAfiacao: false,
      codigoCliente: null, codigoClienteColacor: null, codigoClienteAfiacao: null,
    })).toEqual(['Oben']);
  });

  it('conta SEM itens não é checada mesmo sem código', () => {
    // Só Oben tem itens; Colacor/Afiação sem código mas também sem itens.
    expect(missingAccountIdentities({
      hasOben: true, hasColacor: false, hasAfiacao: false,
      codigoCliente: 100, codigoClienteColacor: null, codigoClienteAfiacao: null,
    })).toEqual([]);
  });

  it('código 0 é inválido (não é código Omie real) → faltando', () => {
    expect(missingAccountIdentities({
      hasOben: false, hasColacor: true, hasAfiacao: false,
      codigoCliente: 100, codigoClienteColacor: 0, codigoClienteAfiacao: null,
    })).toEqual(['Colacor']);
  });

  it('multi-conta: Oben+Colacor com itens, só Colacor sem código → só Colacor', () => {
    expect(missingAccountIdentities({
      hasOben: true, hasColacor: true, hasAfiacao: false,
      codigoCliente: 100, codigoClienteColacor: null, codigoClienteAfiacao: null,
    })).toEqual(['Colacor']);
  });

  it('todas com itens e nenhuma com código → as três, na ordem', () => {
    expect(missingAccountIdentities({
      hasOben: true, hasColacor: true, hasAfiacao: true,
      codigoCliente: null, codigoClienteColacor: null, codigoClienteAfiacao: null,
    })).toEqual(['Oben', 'Colacor', 'Afiação']);
  });
});

describe('isValidOmieClientCode (código Omie de cliente válido)', () => {
  it('número finito > 0 → válido', () => {
    expect(isValidOmieClientCode(1)).toBe(true);
    expect(isValidOmieClientCode(123456)).toBe(true);
  });

  it('0 e negativo → inválido (não é código Omie real)', () => {
    expect(isValidOmieClientCode(0)).toBe(false);
    expect(isValidOmieClientCode(-5)).toBe(false);
  });

  it('NaN e Infinity → inválido (money-path: nunca ao Omie)', () => {
    expect(isValidOmieClientCode(NaN)).toBe(false);
    expect(isValidOmieClientCode(Infinity)).toBe(false);
    expect(isValidOmieClientCode(-Infinity)).toBe(false);
  });

  it('ausente ou tipo errado → inválido (ausente ≠ zero)', () => {
    expect(isValidOmieClientCode(null)).toBe(false);
    expect(isValidOmieClientCode(undefined)).toBe(false);
    expect(isValidOmieClientCode('123')).toBe(false);
  });
});

describe('omieAccountIdentityMissingMessage (fail-closed pt-BR por conta)', () => {
  it('cita o nome da conta conhecida', () => {
    expect(omieAccountIdentityMissingMessage('colacor')).toContain('Colacor');
    expect(omieAccountIdentityMissingMessage('oben')).toContain('Oben');
    expect(omieAccountIdentityMissingMessage('colacor_sc')).toContain('Colacor SC');
  });

  it('conta desconhecida cai no próprio identificador (não quebra)', () => {
    expect(omieAccountIdentityMissingMessage('xyz')).toContain('xyz');
  });
});

// Follow-up do #4068 (Codex): preço de serviço negativo somava no subtotal, mas a linha dizia "A orçar".
describe('subtotalServicosParaExibicao', () => {
  const precoDe = (i: { preco: number | null; quantity: number }) => i.preco;
  it('soma só preço > 0 (× quantidade); negativo, zero e null = a orçar, fora da soma', () => {
    const itens = [
      { preco: 50, quantity: 2 },
      { preco: -30, quantity: 1 },
      { preco: 0, quantity: 3 },
      { preco: null, quantity: 1 },
      { preco: Number.NaN, quantity: 1 },
    ];
    expect(subtotalServicosParaExibicao(itens, precoDe)).toBe(100);
  });
  it('sem itens → 0', () => {
    expect(subtotalServicosParaExibicao([], precoDe)).toBe(0);
  });
});
