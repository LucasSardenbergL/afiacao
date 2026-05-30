import { describe, it, expect } from 'vitest';
import { isStopKeyword } from './stop-keyword';

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
