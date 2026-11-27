import { describe, expect, it } from 'vitest';
import { interpretarCadastro, mensagemBloqueioCadastro, type EstadoCadastro } from '../cadastro-cliente';

// PR 8.2: o cliente do pedido nunca é o vendedor — só `confirmado` libera o envio do staff.
describe('interpretarCadastro (PR 8.2)', () => {
  it('erro da busca é indisponivel — NUNCA "sem cadastro" (ausente ≠ erro)', () => {
    expect(interpretarCadastro(null, new Error('rede'))).toBe('indisponivel');
    expect(interpretarCadastro('u1', new Error('rede'))).toBe('indisponivel');
  });
  it('id encontrado → confirmado; nada encontrado → sem_cadastro', () => {
    expect(interpretarCadastro('u1', null)).toBe('confirmado');
    expect(interpretarCadastro(null, null)).toBe('sem_cadastro');
    expect(interpretarCadastro('  ', null)).toBe('sem_cadastro');
  });
});

describe('mensagemBloqueioCadastro (PR 8.2)', () => {
  it.each<[EstadoCadastro, boolean]>([
    ['confirmado', false], ['resolvendo', true], ['sem_cadastro', true], ['indisponivel', true], ['nao_verificado', true],
  ])('%s bloqueia=%s', (estado, bloqueia) => {
    expect(mensagemBloqueioCadastro(estado) !== null).toBe(bloqueia);
  });
  it('cada bloqueio aponta a saída certa', () => {
    expect(mensagemBloqueioCadastro('indisponivel')).toContain('Trocar');
    expect(mensagemBloqueioCadastro('sem_cadastro')).toContain('Trocar');
    expect(mensagemBloqueioCadastro('sem_cadastro')).toContain('nome do vendedor');
  });
});
