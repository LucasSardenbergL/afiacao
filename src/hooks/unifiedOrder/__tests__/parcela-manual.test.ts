import { describe, it, expect } from 'vitest';
import { podeSugerirParcela, marcaParcelaManualVazia, parcelasManuaisParaRascunho, lerParcelasDoRascunho, decidirParcelaDoRascunho, condicoesComParcelaRetirada } from '../parcela-manual';

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

// Follow-up do #4068 (Codex): código de parcela retirado do Omie entre gravar e restaurar.
describe('decidirParcelaDoRascunho', () => {
  const formas = [{ codigo: '999' }, { codigo: '002' }];
  it('código presente na lista carregada → aplicar', () => {
    expect(decidirParcelaDoRascunho('002', { formas, degradado: false, carregada: true })).toBe('aplicar');
  });
  it('lista completa SEM o código → retirada (não reaplica o obsoleto)', () => {
    expect(decidirParcelaDoRascunho('077', { formas, degradado: false, carregada: true })).toBe('retirada');
  });
  it('lista degradada sem o código → aplicar (o bloqueio de condição ausente já barra o envio)', () => {
    expect(decidirParcelaDoRascunho('077', { formas, degradado: true, carregada: true })).toBe('aplicar');
  });
  it('lista DESTA conta não carregada (carregando/erro) ou vazia → inconferivel', () => {
    expect(decidirParcelaDoRascunho('002', { formas, degradado: false, carregada: false })).toBe('inconferivel');
    expect(decidirParcelaDoRascunho('002', { formas: [], degradado: false, carregada: true })).toBe('inconferivel');
  });
});

// Codex P1: o código PROVADO retirado pode voltar pela sugestão do histórico — enquanto selecionado, bloqueia.
describe('condicoesComParcelaRetirada', () => {
  it('retirada selecionada → entra nas condições ausentes (bloqueio de envio)', () => {
    expect(condicoesComParcelaRetirada([], '077', '077')).toEqual(['077']);
  });
  it('outro prazo selecionado, ou nada retirado → ausentes inalteradas', () => {
    expect(condicoesComParcelaRetirada([], '077', '002')).toEqual([]);
    expect(condicoesComParcelaRetirada(['010'], null, '010')).toEqual(['010']);
  });
  it('já ausente pela degradação → não duplica', () => {
    expect(condicoesComParcelaRetirada(['077'], '077', '077')).toEqual(['077']);
  });
});
