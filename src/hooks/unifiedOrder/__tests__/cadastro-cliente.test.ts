import { describe, expect, it } from 'vitest';
import { interpretarCadastro, mensagemBloqueioCadastro, MSG_CADASTRO_ENVIO_PENDENTE, type EstadoCadastro } from '../cadastro-cliente';

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

// 8.2 (Codex r3/r4): com envio pendente, "Trocar" zera o checkoutId → 2º PV. A saída é recarregar.
describe('mensagemBloqueioCadastro com envio pendente', () => {
  it.each(['sem_cadastro', 'indisponivel'] as const)('%s + envio pendente → recarregar, NÃO "use Trocar"', (estado) => {
    const m = mensagemBloqueioCadastro(estado, true) ?? '';
    expect(m).toBe(MSG_CADASTRO_ENVIO_PENDENTE);
    expect(m).toContain('recarregue a página');
    expect(m).toContain('Não use “Trocar”');
  });
  it('confirmado continua liberando com envio pendente; resolvendo continua aguardando', () => {
    expect(mensagemBloqueioCadastro('confirmado', true)).toBeNull();
    expect(mensagemBloqueioCadastro('resolvendo', true)).toContain('Aguarde');
  });
});
