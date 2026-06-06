import { describe, it, expect } from 'vitest';
import { isOmiePedidoJaCadastrado, extrairPedidoOmie, deveCriarPedidoOmie } from '../omie-disparo-helpers';

describe('isOmiePedidoJaCadastrado', () => {
  it('detecta "já cadastrado" em pt-BR (com acento)', () => {
    expect(isOmiePedidoJaCadastrado('Omie IncluirPedCompra erro [500]: Pedido de compra já cadastrado')).toBe(true);
  });
  it('detecta sem acento', () => {
    expect(isOmiePedidoJaCadastrado('Pedido de compra ja cadastrado')).toBe(true);
  });
  it('detecta menção a código de integração já cadastrado', () => {
    expect(isOmiePedidoJaCadastrado('O codigo de integracao [AFI-123] ja foi cadastrado')).toBe(true);
  });
  it('detecta "already registered" (inglês)', () => {
    expect(isOmiePedidoJaCadastrado('Purchase order already registered')).toBe(true);
  });
  it('NÃO detecta erro genérico de validação', () => {
    expect(isOmiePedidoJaCadastrado('Omie IncluirPedCompra erro [500]: O preenchimento da tag [nValUnit] é obrigatório')).toBe(false);
  });
  it('NÃO confunde "cliente cadastrado com sucesso"', () => {
    expect(isOmiePedidoJaCadastrado('Cliente cadastrado com sucesso')).toBe(false);
  });
  it('NÃO false-positiva em "integra*" genérico sem "código de integração"', () => {
    expect(isOmiePedidoJaCadastrado('Produto integral cadastrado no estoque')).toBe(false);
  });
  it('trata null/undefined/vazio', () => {
    expect(isOmiePedidoJaCadastrado(null)).toBe(false);
    expect(isOmiePedidoJaCadastrado(undefined)).toBe(false);
    expect(isOmiePedidoJaCadastrado('')).toBe(false);
  });
});

describe('extrairPedidoOmie', () => {
  it('extrai de pedido_compra_cabecalho', () => {
    expect(extrairPedidoOmie({ pedido_compra_cabecalho: { nCodPed: 999, cNumero: '12345' } }))
      .toEqual({ id: '999', numero: '12345' });
  });
  it('extrai de cabecalho_consulta (formato do PesquisarPedCompra)', () => {
    expect(extrairPedidoOmie({ cabecalho_consulta: { nCodPed: 888 } }))
      .toEqual({ id: '888', numero: '' });
  });
  it('extrai cNumero aninhado em cabecalho_consulta', () => {
    expect(extrairPedidoOmie({ cabecalho_consulta: { nCodPed: 888, cNumero: '99' } }))
      .toEqual({ id: '888', numero: '99' });
  });
  it('extrai de cabecalho (sem sufixo)', () => {
    expect(extrairPedidoOmie({ cabecalho: { nCodPed: 666, cNumero: '44' } }))
      .toEqual({ id: '666', numero: '44' });
  });
  it('extrai de cabecalho cru no topo', () => {
    expect(extrairPedidoOmie({ nCodPed: 777, cNumero: '55' })).toEqual({ id: '777', numero: '55' });
  });
  it('retorna null quando não há id', () => {
    expect(extrairPedidoOmie({ foo: 'bar' })).toBeNull();
    expect(extrairPedidoOmie(null)).toBeNull();
    expect(extrairPedidoOmie(undefined)).toBeNull();
  });
});

describe('deveCriarPedidoOmie (guard anti-PO-duplicado · 3b)', () => {
  it('PO já existe (id real) → NÃO recriar', () => {
    expect(deveCriarPedidoOmie('12345')).toBe(false);
    expect(deveCriarPedidoOmie(12345)).toBe(false);
    expect(deveCriarPedidoOmie('AFI-130')).toBe(false);
  });
  it('sem PO (null/undefined) → criar (comportamento de hoje)', () => {
    expect(deveCriarPedidoOmie(null)).toBe(true);
    expect(deveCriarPedidoOmie(undefined)).toBe(true);
  });
  it('string vazia / whitespace (o disparo grava "" sem id) → criar', () => {
    expect(deveCriarPedidoOmie('')).toBe(true);
    expect(deveCriarPedidoOmie('   ')).toBe(true);
  });
  it('"0" / 0 representam vazio → criar (não bloqueia criação legítima)', () => {
    expect(deveCriarPedidoOmie('0')).toBe(true);
    expect(deveCriarPedidoOmie(0)).toBe(true);
  });
});
