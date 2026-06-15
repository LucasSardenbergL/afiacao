import { describe, it, expect } from 'vitest';
import {
  isOmiePedidoJaCadastrado,
  extrairPedidoOmie,
  deveCriarPedidoOmie,
  portalEnviadoPorAutomacao,
  deveEnviarEmailPortalManual,
} from '../omie-disparo-helpers';

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

describe('portalEnviadoPorAutomacao (Sayerlack/OBEN cola sozinho via Browserless)', () => {
  it('OBEN + RENNER SAYERLACK → automatizado', () => {
    expect(portalEnviadoPorAutomacao({ empresa: 'OBEN', fornecedor_nome: 'RENNER SAYERLACK S/A' })).toBe(true);
  });
  it('reconhece "sayerlack" em qualquer caixa / posição no nome', () => {
    expect(portalEnviadoPorAutomacao({ empresa: 'OBEN', fornecedor_nome: 'Sayerlack' })).toBe(true);
    expect(portalEnviadoPorAutomacao({ empresa: 'oben', fornecedor_nome: 'tintas sayerlack ltda' })).toBe(true);
  });
  it('OBEN + fornecedor não-Sayerlack → NÃO automatizado', () => {
    expect(portalEnviadoPorAutomacao({ empresa: 'OBEN', fornecedor_nome: 'ACRE CAXIAS IND. E COM. DE ABRASIVOS LTDA' })).toBe(false);
  });
  it('Sayerlack em outra empresa que não OBEN → NÃO automatizado (automação é OBEN-only)', () => {
    expect(portalEnviadoPorAutomacao({ empresa: 'COLACOR', fornecedor_nome: 'RENNER SAYERLACK S/A' })).toBe(false);
  });
  it('empresa/nome nulos ou vazios → NÃO automatizado', () => {
    expect(portalEnviadoPorAutomacao({ empresa: null, fornecedor_nome: null })).toBe(false);
    expect(portalEnviadoPorAutomacao({ empresa: 'OBEN', fornecedor_nome: '' })).toBe(false);
    expect(portalEnviadoPorAutomacao({})).toBe(false);
  });
});

describe('deveEnviarEmailPortalManual (suprime o "[Portal B2B] cole na mão" redundante)', () => {
  it('Sayerlack/OBEN → NÃO enviar (automação já colou; aviso "insere manualmente" é enganoso)', () => {
    expect(deveEnviarEmailPortalManual({ empresa: 'OBEN', fornecedor_nome: 'RENNER SAYERLACK S/A' })).toBe(false);
  });
  it('portal_b2b SEM automação (não-Sayerlack) → AINDA enviar (staff cola de verdade)', () => {
    expect(deveEnviarEmailPortalManual({ empresa: 'OBEN', fornecedor_nome: 'OUTRO FORNECEDOR PORTAL' })).toBe(true);
  });
  it('conservador: na dúvida (empresa/nome ausentes) → enviar (não suprime sem certeza de automação)', () => {
    expect(deveEnviarEmailPortalManual({ empresa: null, fornecedor_nome: null })).toBe(true);
    expect(deveEnviarEmailPortalManual({})).toBe(true);
  });
});
