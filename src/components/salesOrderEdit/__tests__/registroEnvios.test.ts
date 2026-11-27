import { describe, it, expect, beforeEach } from 'vitest';
import { encerrarEnvio, estadoDoPedido, iniciarEnvio, limparRegistroParaTeste, marcarDivergente } from '../registroEnvios';

const ID = '2f8a04c9-2daf-4cf9-bdbf-047d16765ea7';

describe('registroEnvios — um envio por pedido, chave canônica (Codex 2026-11-26)', () => {
  beforeEach(() => limparRegistroParaTeste());

  it('aquisição: o 2º iniciarEnvio do mesmo pedido falha até o 1º encerrar', () => {
    expect(iniciarEnvio(ID)).toBe(true);
    expect(iniciarEnvio(ID)).toBe(false);
    encerrarEnvio(ID);
    expect(iniciarEnvio(ID)).toBe(true);
  });

  it('UUID em maiúsculas é o MESMO pedido (rota aceita, banco devolve minúsculas)', () => {
    expect(iniciarEnvio(ID)).toBe(true);
    expect(iniciarEnvio(ID.toUpperCase())).toBe(false);
    expect(estadoDoPedido(ID.toUpperCase()).emVoo).toBe(true);
    marcarDivergente(ID);
    expect(estadoDoPedido(ID.toUpperCase()).divergente).toBe(true);
  });
});

describe('registroEnvios — grafias do UUID e divergente recusa envio', () => {
  beforeEach(() => limparRegistroParaTeste());

  it('sem hífens e entre chaves é o MESMO pedido', () => {
    marcarDivergente(ID);
    expect(estadoDoPedido(ID.replace(/-/g, '')).divergente).toBe(true);
    expect(estadoDoPedido(`{${ID.toUpperCase()}}`).divergente).toBe(true);
  });

  it('pedido divergente não adquire envio, em nenhuma grafia', () => {
    marcarDivergente(ID);
    expect(iniciarEnvio(ID.replace(/-/g, ''))).toBe(false);
  });
});
