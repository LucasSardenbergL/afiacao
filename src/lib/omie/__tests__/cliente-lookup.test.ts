import { describe, it, expect } from 'vitest';
import { classifyClienteLookup, deterministicIntegrationCode, isDocumentoValido } from '../cliente-lookup';

describe('classifyClienteLookup (tri-state: found/absent/error)', () => {
  it('threw=true → error(threw), mesmo sem clientes', () => {
    expect(classifyClienteLookup({ threw: true })).toEqual({ status: 'error', reason: 'threw' });
  });

  it('threw vence mesmo se vier clientes (não confiar em payload pós-erro)', () => {
    expect(classifyClienteLookup({ threw: true, clientes: [{ codigo_cliente_omie: 5 }] }))
      .toEqual({ status: 'error', reason: 'threw' });
  });

  // ⚠️ Codex: null/undefined = resposta inesperada/malformada → ERROR, não absent.
  // Só um ARRAY VAZIO de verdade é "cliente não existe" (absent).
  it('clientes null/undefined → error(malformed) (NÃO absent)', () => {
    expect(classifyClienteLookup({ threw: false, clientes: null })).toEqual({ status: 'error', reason: 'malformed' });
    expect(classifyClienteLookup({ threw: false })).toEqual({ status: 'error', reason: 'malformed' });
  });

  it('array vazio → absent (cliente confirmadamente não existe)', () => {
    expect(classifyClienteLookup({ threw: false, clientes: [] })).toEqual({ status: 'absent' });
  });

  // ⚠️ Codex: documento duplicado no Omie → não escolher o primeiro arbitrariamente.
  it('mais de um cliente → error(ambiguous)', () => {
    expect(classifyClienteLookup({
      threw: false,
      clientes: [{ codigo_cliente_omie: 1 }, { codigo_cliente_omie: 2 }],
    })).toEqual({ status: 'error', reason: 'ambiguous' });
  });

  it('cliente com codigo_cliente_omie + vendedor em recomendacoes → found', () => {
    expect(classifyClienteLookup({
      threw: false,
      clientes: [{ codigo_cliente_omie: 200, recomendacoes: { codigo_vendedor: 6 } }],
    })).toEqual({ status: 'found', codigo_cliente: 200, codigo_vendedor: 6 });
  });

  it('cliente com codigo_cliente (sem omie) + vendedor na raiz → found', () => {
    expect(classifyClienteLookup({
      threw: false,
      clientes: [{ codigo_cliente: 300, codigo_vendedor: 9 }],
    })).toEqual({ status: 'found', codigo_cliente: 300, codigo_vendedor: 9 });
  });

  it('found sem vendedor → codigo_vendedor null', () => {
    expect(classifyClienteLookup({ threw: false, clientes: [{ codigo_cliente_omie: 7 }] }))
      .toEqual({ status: 'found', codigo_cliente: 7, codigo_vendedor: null });
  });

  it('recomendacoes tem prioridade sobre vendedor na raiz', () => {
    expect(classifyClienteLookup({
      threw: false,
      clientes: [{ codigo_cliente_omie: 1, codigo_vendedor: 5, recomendacoes: { codigo_vendedor: 6 } }],
    })).toEqual({ status: 'found', codigo_cliente: 1, codigo_vendedor: 6 });
  });

  // ⚠️ Codex: uma linha SEM código válido é resposta malformada → error (não absent).
  it('linha única sem código válido (0/ausente) → error(malformed)', () => {
    expect(classifyClienteLookup({ threw: false, clientes: [{ codigo_cliente_omie: 0 }] }))
      .toEqual({ status: 'error', reason: 'malformed' });
    expect(classifyClienteLookup({ threw: false, clientes: [{ razao_social: 'X' }] }))
      .toEqual({ status: 'error', reason: 'malformed' });
  });
});

describe('isDocumentoValido', () => {
  it('11 (CPF) ou 14 (CNPJ) dígitos = válido', () => {
    expect(isDocumentoValido('123.456.789-00')).toBe(true);
    expect(isDocumentoValido('12.345.678/0001-99')).toBe(true);
  });
  it('outros tamanhos = inválido', () => {
    expect(isDocumentoValido('123')).toBe(false);
    expect(isDocumentoValido('')).toBe(false);
    expect(isDocumentoValido('123456789012')).toBe(false); // 12 dígitos
  });
});

describe('deterministicIntegrationCode', () => {
  it('namespace B2B_CLI_ + dígitos do doc', () => {
    expect(deterministicIntegrationCode('12.345.678/0001-99')).toBe('B2B_CLI_12345678000199');
    expect(deterministicIntegrationCode('123.456.789-00')).toBe('B2B_CLI_12345678900');
  });

  it('determinístico: mesma entrada lógica → mesma saída (sem timestamp)', () => {
    expect(deterministicIntegrationCode('12345678000199')).toBe(deterministicIntegrationCode('12.345.678/0001-99'));
  });

  it('documento inválido → null (não cria com doc ruim)', () => {
    expect(deterministicIntegrationCode('123')).toBeNull();
    expect(deterministicIntegrationCode('')).toBeNull();
  });
});
