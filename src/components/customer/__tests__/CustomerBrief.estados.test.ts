import { describe, it, expect } from 'vitest';
import { estadoFonteBrief } from '../CustomerBrief';

describe('estadoFonteBrief — cada fonte do resumo fala por si', () => {
  it('carregando sem dado', () => {
    expect(estadoFonteBrief({ isPending: true, isError: false, data: undefined })).toBe('carregando');
  });
  it('falha sem dado → falha (vira "indisponível", nunca "nunca comprou"/"nenhuma")', () => {
    expect(estadoFonteBrief({ isPending: false, isError: true, data: undefined })).toBe('falha');
  });
  it('sucesso com null (nenhum registro) é ok — aí sim "nunca comprou"', () => {
    expect(estadoFonteBrief({ isPending: false, isError: false, data: null })).toBe('ok');
  });
  it('dado em cache com refetch falho segue ok (última leitura boa)', () => {
    expect(estadoFonteBrief({ isPending: false, isError: true, data: [] })).toBe('ok');
  });
});
