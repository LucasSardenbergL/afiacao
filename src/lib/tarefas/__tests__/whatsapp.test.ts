import { describe, it, expect } from 'vitest';
import { buildWhatsappTaskMessage, buildWaMeUrl } from '../whatsapp';

describe('buildWhatsappTaskMessage', () => {
  it('usa a descrição da tarefa como corpo', () => {
    expect(buildWhatsappTaskMessage({ descricao: 'Manda o catálogo 2026' }))
      .toBe('Manda o catálogo 2026');
  });
  it('inclui o texto-alvo quando presente', () => {
    expect(buildWhatsappTaskMessage({ descricao: 'Enviar dados', target_texto: 'Tabela verniz X' }))
      .toBe('Enviar dados\n\nTabela verniz X');
  });
  it('trim e ignora alvo vazio', () => {
    expect(buildWhatsappTaskMessage({ descricao: '  Oi  ', target_texto: '   ' })).toBe('Oi');
  });
});

describe('buildWaMeUrl', () => {
  it('monta wa.me com telefone limpo e texto encodado', () => {
    expect(buildWaMeUrl('(37) 99999-1234', 'Olá, tudo bem?'))
      .toBe('https://wa.me/5537999991234?text=Ol%C3%A1%2C%20tudo%20bem%3F');
  });
  it('sem telefone → wa.me sem número (escolhe contato no app)', () => {
    expect(buildWaMeUrl(null, 'Oi')).toBe('https://wa.me/?text=Oi');
  });
});
