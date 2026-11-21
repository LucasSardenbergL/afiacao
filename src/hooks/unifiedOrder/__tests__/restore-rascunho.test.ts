import { describe, it, expect } from 'vitest';
import { codigoClienteIdentifica, decidirRestore, resolverRestorePendente } from '../restore-rascunho';

// Follow-up Codex P1 do #4068: rascunho de A restaurado sem cliente na tela não pode ir no pedido de B.
describe('decidirRestore', () => {
  it('rascunho de A sem cliente na tela: ESPERA o cliente (não aplica o carrinho já)', () => {
    expect(decidirRestore(101, null)).toBe('esperarCliente');
  });

  it('rascunho de A com A na tela: aplica', () => {
    expect(decidirRestore(101, 101)).toBe('aplicar');
  });

  it('rascunho de A com B na tela: recusa', () => {
    expect(decidirRestore(101, 202)).toBe('recusar');
  });

  it('rascunho sem cliente: aplica como sempre (não há dono a esperar)', () => {
    expect(decidirRestore(null, null)).toBe('aplicar');
    expect(decidirRestore(null, 202)).toBe('aplicar');
  });

  it('código 0 não identifica ninguém: não espera, mas o guard de códigos diferentes segue', () => {
    expect(decidirRestore(0, null)).toBe('aplicar');
    expect(decidirRestore(0, 202)).toBe('recusar');
  });
});

describe('resolverRestorePendente', () => {
  it('sem cliente selecionado: continua esperando', () => {
    expect(resolverRestorePendente(101, null)).toBe('esperar');
  });

  it('selecionou o cliente DO rascunho: aplica', () => {
    expect(resolverRestorePendente(101, 101)).toBe('aplicar');
  });

  it('selecionou OUTRO cliente: descarta (o carrinho de A não entra no pedido de B)', () => {
    expect(resolverRestorePendente(101, 202)).toBe('descartar');
  });
});

describe('codigoClienteIdentifica', () => {
  it('só código positivo e finito identifica', () => {
    expect(codigoClienteIdentifica(101)).toBe(true);
    expect(codigoClienteIdentifica(0)).toBe(false);
    expect(codigoClienteIdentifica(-3)).toBe(false);
    expect(codigoClienteIdentifica(Number.NaN)).toBe(false);
    expect(codigoClienteIdentifica(null)).toBe(false);
    expect(codigoClienteIdentifica(undefined)).toBe(false);
  });
});
