import { describe, it, expect } from 'vitest';
import { normalizeBrPhone, formatBrPhone, whatsappLink, isCellphone } from '../phone';

describe('normalizeBrPhone', () => {
  it('falsy → string vazia', () => {
    expect(normalizeBrPhone(null)).toBe('');
    expect(normalizeBrPhone(undefined)).toBe('');
    expect(normalizeBrPhone('')).toBe('');
  });

  it('tira a formatação de um celular com DDD', () => {
    expect(normalizeBrPhone('(37) 99999-8888')).toBe('37999998888');
  });

  it('celular sem DDD (9 díg) → aplica o DDD padrão 37', () => {
    expect(normalizeBrPhone('99999-8888')).toBe('37999998888');
  });

  it('fixo sem DDD (8 díg) → aplica o DDD padrão 37', () => {
    expect(normalizeBrPhone('3333-4444')).toBe('3733334444');
  });

  it('remove o código de país +55 quando há mais de 11 dígitos', () => {
    expect(normalizeBrPhone('5537999998888')).toBe('37999998888');
    expect(normalizeBrPhone('+55 (37) 99999-8888')).toBe('37999998888');
  });

  it('11 dígitos começando com 55 NÃO tira o 55 (regra só em >11; 55 vira DDD)', () => {
    expect(normalizeBrPhone('55999998888')).toBe('55999998888');
  });

  it('respeita um defaultDdd custom', () => {
    expect(normalizeBrPhone('999998888', '11')).toBe('11999998888');
  });

  it('já normalizado (11/10 díg) passa inalterado', () => {
    expect(normalizeBrPhone('37999998888')).toBe('37999998888');
    expect(normalizeBrPhone('3733334444')).toBe('3733334444');
  });

  it('lixo curto passa sem validação de DDD', () => {
    expect(normalizeBrPhone('123')).toBe('123');
  });
});

describe('formatBrPhone', () => {
  it('11 dígitos → (DD) 9XXXX-XXXX', () => {
    expect(formatBrPhone('99999-8888')).toBe('(37) 99999-8888');
    expect(formatBrPhone('37999998888')).toBe('(37) 99999-8888');
  });

  it('10 dígitos → (DD) XXXX-XXXX (reformata consistente)', () => {
    expect(formatBrPhone('3733334444')).toBe('(37) 3333-4444');
    expect(formatBrPhone('(37) 3333-4444')).toBe('(37) 3333-4444');
  });

  it('falsy → string vazia', () => {
    expect(formatBrPhone(null)).toBe('');
    expect(formatBrPhone('')).toBe('');
  });

  it('não bate 10/11 dígitos → devolve o input original', () => {
    expect(formatBrPhone('123')).toBe('123');
  });
});

describe('whatsappLink', () => {
  it('fixo sem DDD (8 díg) → aplica DDD 37 + prefixa 55', () => {
    expect(whatsappLink('35213493')).toBe('https://wa.me/553735213493');
  });

  it('celular com DDD formatado → só dígitos + 55', () => {
    expect(whatsappLink('(37) 99999-8888')).toBe('https://wa.me/5537999998888');
  });

  it('já com +55 → não duplica o 55', () => {
    expect(whatsappLink('5537999998888')).toBe('https://wa.me/5537999998888');
  });

  it('número curto / lixo / falsy → null (call-site esconde o botão)', () => {
    expect(whatsappLink('123')).toBeNull();
    expect(whatsappLink(null)).toBeNull();
    expect(whatsappLink(undefined)).toBeNull();
    expect(whatsappLink('')).toBeNull();
  });

  it('mensagem opcional vira ?text= URL-encoded', () => {
    expect(whatsappLink('37999998888', 'Olá, tudo bem?')).toBe(
      'https://wa.me/5537999998888?text=Ol%C3%A1%2C%20tudo%20bem%3F',
    );
  });

  it('sem mensagem não adiciona ?text=', () => {
    expect(whatsappLink('37999998888')).toBe('https://wa.me/5537999998888');
  });
});

describe('isCellphone', () => {
  it('celular com DDD (11 dígitos, 9 na frente) → true', () => {
    expect(isCellphone('31999990001')).toBe(true);
    expect(isCellphone('(31) 99999-0001')).toBe(true);
    expect(isCellphone('5531999990001')).toBe(true); // com +55
  });
  it('fixo (10 dígitos) → false', () => {
    expect(isCellphone('3133334444')).toBe(false);
    expect(isCellphone('(31) 3333-4444')).toBe(false);
  });
  it('vazio/nulo/curto → false', () => {
    expect(isCellphone(null)).toBe(false);
    expect(isCellphone(undefined)).toBe(false);
    expect(isCellphone('')).toBe(false);
    expect(isCellphone('999')).toBe(false);
  });
  it('sem DDD com 9 dígitos (9XXXX-XXXX) → aplica DDD padrão e é celular', () => {
    expect(isCellphone('999990001')).toBe(true);
  });
});
