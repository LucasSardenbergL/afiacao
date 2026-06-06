import { describe, it, expect } from 'vitest';
import { missingAccountIdentities } from '../helpers';

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
