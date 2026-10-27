import { describe, it, expect } from 'vitest';
import { situacaoItensNf } from './itens-da-nf';

describe('situacaoItensNf', () => {
  it('com item → com_itens, qualquer status', () => {
    expect(situacaoItensNf('efetivado', [{}])).toBe('com_itens');
    expect(situacaoItensNf('pendente', [{}])).toBe('com_itens');
  });

  it('efetivado sem item → recebida_fora_do_app', () => {
    expect(situacaoItensNf('efetivado', [])).toBe('recebida_fora_do_app');
    expect(situacaoItensNf('efetivado', null)).toBe('recebida_fora_do_app');
  });

  it('não efetivado sem item → itens_nao_carregados (falha, pendente, status ausente)', () => {
    expect(situacaoItensNf('falha_efetivacao', [])).toBe('itens_nao_carregados');
    expect(situacaoItensNf('pendente', undefined)).toBe('itens_nao_carregados');
    expect(situacaoItensNf(undefined, [])).toBe('itens_nao_carregados');
  });
});
