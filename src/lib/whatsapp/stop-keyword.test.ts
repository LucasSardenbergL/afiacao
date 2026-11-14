import { describe, it, expect } from 'vitest';
import { isRejoinKeyword, isStopKeyword } from './stop-keyword';

describe('isStopKeyword', () => {
  it.each(['PARAR', 'parar', '  Parar  ', 'SAIR', 'stop', 'Cancelar', 'descadastrar', 'PARAR.'])(
    'reconhece "%s" como opt-out', (s) => expect(isStopKeyword(s)).toBe(true),
  );
  it.each(['quero parar de receber só esse produto', 'oi', '', 'pare na esquina'])(
    'NÃO trata "%s" como opt-out (evita falso-positivo em frase)', (s) => expect(isStopKeyword(s)).toBe(false),
  );
  it('null/undefined → false', () => {
    expect(isStopKeyword(null)).toBe(false);
    expect(isStopKeyword(undefined)).toBe(false);
  });
});

describe('isRejoinKeyword', () => {
  it.each(['VOLTAR', 'voltar', '  Voltar! ', 'vóltar'])(
    'reconhece "%s" como volta ao opt-in', (s) => expect(isRejoinKeyword(s)).toBe(true),
  );
  it.each(['quero voltar a comprar', 'oi', '', 'PARAR', null, undefined])(
    'NÃO trata "%s" como volta (só a mensagem inteira conta)', (s) => expect(isRejoinKeyword(s)).toBe(false),
  );
});
