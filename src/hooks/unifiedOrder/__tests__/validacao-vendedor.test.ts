import { describe, it, expect } from 'vitest';
import {
  interpretarValidacaoVendedor,
  mensagemBloqueioVendedor,
  type EstadoVendedor,
} from '../validacao-vendedor';

describe('8.1 — validação do vendedor falha fechado (ausente ≠ consistente)', () => {
  it('só consistente === true libera', () => {
    expect(interpretarValidacaoVendedor({ consistente: true, divergencias: [] }, null))
      .toEqual({ estado: 'consistente', divergencias: [] });
  });

  it.each<[string, unknown, unknown]>([
    ['erro do invoke (4xx/5xx/rede)', null, new Error('FunctionsHttpError')],
    ['erro E dado', { consistente: true }, new Error('x')],
    ['sem dado', null, null],
    ['dado não-objeto', 'ok', null],
    ['sem o campo consistente', { divergencias: [] }, null],
    ['consistente como string', { consistente: 'true' }, null],
    ['corpo com error', { error: 'Token inválido', consistente: true }, null],
  ])('%s → indisponivel (bloqueia)', (_n, data, error) => {
    const r = interpretarValidacaoVendedor(data, error);
    expect(r.estado).toBe('indisponivel');
    expect(mensagemBloqueioVendedor(r.estado)).not.toBeNull();
  });

  it('divergente traz a lista do Omie', () => {
    const r = interpretarValidacaoVendedor({ consistente: false, divergencias: ['Oben: A', 'Colacor: B'] }, null);
    expect(r).toEqual({ estado: 'divergente', divergencias: ['Oben: A', 'Colacor: B'] });
  });

  it('divergente SEM lista não reabre o envio (lista vazia ganharia um item genérico)', () => {
    const r = interpretarValidacaoVendedor({ consistente: false, divergencias: [] }, null);
    expect(r.estado).toBe('divergente');
    expect(r.divergencias.length).toBe(1);
  });

  it.each<[EstadoVendedor, boolean]>([
    ['nao_verificado', false],
    ['consistente', false],
    ['validando', true],
    ['divergente', true],
    ['indisponivel', true],
  ])('%s bloqueia o envio? %s', (estado, bloqueia) => {
    expect(mensagemBloqueioVendedor(estado) !== null).toBe(bloqueia);
  });
});
