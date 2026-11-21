import { describe, it, expect } from 'vitest';
import { podeSugerirParcela, marcaParcelaManualVazia, parcelasManuaisParaRascunho, lerParcelasDoRascunho } from '../parcela-manual';

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

// B7 (rodada 2): o rascunho guarda o prazo escolhido à mão — e só ele.
describe('parcelasManuaisParaRascunho / lerParcelasDoRascunho', () => {
  it('guarda só a conta marcada como manual NESTA seleção', () => {
    expect(parcelasManuaisParaRascunho({ oben: 3, colacor: null }, 3, { oben: '030', colacor: '999' }))
      .toEqual({ oben: '030', colacor: null });
  });
  it('marca de OUTRA seleção não vale (prazo veio do histórico)', () => {
    expect(parcelasManuaisParaRascunho({ oben: 2, colacor: 2 }, 3, { oben: '030', colacor: '060' }))
      .toEqual({ oben: null, colacor: null });
  });
  it('lê o rascunho em disco: válido, antigo (sem campo) e adulterado', () => {
    expect(lerParcelasDoRascunho({ oben: '030', colacor: null })).toEqual({ oben: '030', colacor: null });
    expect(lerParcelasDoRascunho(undefined)).toBeNull();
    expect(lerParcelasDoRascunho({ oben: null, colacor: null })).toBeNull();
    expect(lerParcelasDoRascunho({ oben: 30, colacor: '' })).toBeNull();
  });
});
