import { describe, expect, it } from 'vitest';
import { validarEnvioPush, montarNotificacao, type EnvioPushValido } from './payload';

const VALIDO = {
  user_ids: ['7f6a4c1e-1111-4222-8333-944455556666'],
  titulo: 'Nova mensagem',
  corpo: 'Cliente X respondeu no WhatsApp',
  url: '/whatsapp',
  tag: 'wa-abc',
};

describe('validarEnvioPush', () => {
  it('aceita payload completo e devolve os dados normalizados', () => {
    const r = validarEnvioPush(VALIDO);
    expect(r.ok).toBe(true);
    const dados = (r as { ok: true; dados: EnvioPushValido }).dados;
    expect(dados.user_ids).toEqual(VALIDO.user_ids);
    expect(dados.titulo).toBe('Nova mensagem');
  });

  it('rejeita user_ids vazio, ausente ou não-uuid', () => {
    expect(validarEnvioPush({ ...VALIDO, user_ids: [] }).ok).toBe(false);
    expect(validarEnvioPush({ ...VALIDO, user_ids: undefined }).ok).toBe(false);
    expect(validarEnvioPush({ ...VALIDO, user_ids: ['nao-uuid'] }).ok).toBe(false);
    expect(validarEnvioPush({ ...VALIDO, user_ids: 'uuid-solto' }).ok).toBe(false);
  });

  it('rejeita titulo vazio ou ausente', () => {
    expect(validarEnvioPush({ ...VALIDO, titulo: '' }).ok).toBe(false);
    expect(validarEnvioPush({ ...VALIDO, titulo: '   ' }).ok).toBe(false);
    expect(validarEnvioPush({ ...VALIDO, titulo: undefined }).ok).toBe(false);
  });

  it('corpo/url/tag são opcionais (defaults seguros)', () => {
    const r = validarEnvioPush({ user_ids: VALIDO.user_ids, titulo: 'Oi' });
    expect(r.ok).toBe(true);
    const dados = (r as { ok: true; dados: EnvioPushValido }).dados;
    expect(dados.corpo).toBe('');
    expect(dados.url).toBe('/');
    expect(dados.tag).toBeUndefined();
  });

  it('trunca titulo e corpo nos limites (lock screen, payload ~4KB)', () => {
    const r = validarEnvioPush({
      ...VALIDO,
      titulo: 'a'.repeat(300),
      corpo: 'b'.repeat(1000),
    });
    expect(r.ok).toBe(true);
    const dados = (r as { ok: true; dados: EnvioPushValido }).dados;
    expect(dados.titulo.length).toBeLessThanOrEqual(120);
    expect(dados.corpo.length).toBeLessThanOrEqual(240);
  });

  it('rejeita url externa (só path interno — o SW abre a própria origem)', () => {
    expect(validarEnvioPush({ ...VALIDO, url: 'https://evil.com/x' }).ok).toBe(false);
    expect(validarEnvioPush({ ...VALIDO, url: '//evil.com' }).ok).toBe(false);
    expect(validarEnvioPush({ ...VALIDO, url: '/meu-dia' }).ok).toBe(true);
  });

  it('dedupe de user_ids repetidos (não manda 2 pushes pro mesmo user)', () => {
    const r = validarEnvioPush({ ...VALIDO, user_ids: [VALIDO.user_ids[0], VALIDO.user_ids[0]] });
    expect(r.ok).toBe(true);
    expect((r as { ok: true; dados: EnvioPushValido }).dados.user_ids).toHaveLength(1);
  });
});

describe('montarNotificacao', () => {
  it('monta o JSON que o SW espera (title/body/url/tag)', () => {
    const dados = (validarEnvioPush(VALIDO) as { ok: true; dados: EnvioPushValido }).dados;
    const n = montarNotificacao(dados);
    expect(n).toEqual({
      titulo: 'Nova mensagem',
      corpo: 'Cliente X respondeu no WhatsApp',
      url: '/whatsapp',
      tag: 'wa-abc',
    });
  });
});
