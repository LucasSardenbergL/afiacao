import { describe, it, expect } from 'vitest';
import { podeSugerirParcela, marcaParcelaManualVazia } from '../parcela-manual';

// A7 (rodada 2): o histórico (ultima_parcela) chega depois da seleção — não pode atropelar a escolha manual.
describe('podeSugerirParcela', () => {
  it('conta escolhida à mão NESTA seleção → a sugestão do histórico NÃO entra', () => {
    expect(podeSugerirParcela(7, 7)).toBe(false);
  });
  it('sem escolha manual → sugere', () => {
    expect(podeSugerirParcela(marcaParcelaManualVazia().oben, 7)).toBe(true);
  });
  it('escolha manual de OUTRA seleção (outro cliente) não vale aqui → sugere', () => {
    expect(podeSugerirParcela(6, 7)).toBe(true);
  });
});
