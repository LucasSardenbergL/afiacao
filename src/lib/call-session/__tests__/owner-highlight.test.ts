import { describe, it, expect } from 'vitest';
import { classificarRealceDono } from '../owner-highlight';

describe('classificarRealceDono', () => {
  it('cliente não identificado → desconhecido', () => {
    expect(classificarRealceDono({ ownerUserId: null, currentUserId: 'u1', customerUserId: null })).toBe('desconhecido');
  });
  it('cliente identificado mas sem dono na carteira → sem_dono', () => {
    expect(classificarRealceDono({ ownerUserId: null, currentUserId: 'u1', customerUserId: 'c1' })).toBe('sem_dono');
  });
  it('dono efetivo == usuário logado → meu', () => {
    expect(classificarRealceDono({ ownerUserId: 'u1', currentUserId: 'u1', customerUserId: 'c1' })).toBe('meu');
  });
  it('dono efetivo != usuário logado → outro', () => {
    expect(classificarRealceDono({ ownerUserId: 'u2', currentUserId: 'u1', customerUserId: 'c1' })).toBe('outro');
  });
  it('sem usuário logado mas com dono → outro (não pode ser "meu" sem saber quem sou)', () => {
    expect(classificarRealceDono({ ownerUserId: 'u2', currentUserId: null, customerUserId: 'c1' })).toBe('outro');
  });
});
