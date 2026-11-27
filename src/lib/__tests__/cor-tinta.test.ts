import { describe, expect, it } from 'vitest';
import { textoDaCor } from '../cor-tinta';

// Revisão /sales #24: o cupom exigia id E nome, a mensagem exigia o id — e o sync grava quase sempre
// só o nome (6.556 itens vivos em 2026-11-27).
describe('textoDaCor', () => {
  it('so o nome (caso dominante do sync) sai, sem o sufixo de base', () => {
    expect(textoDaCor(undefined, '652J ACRIL BS - COBRE MEL - BS', 'BASE ACRIL MULT MET')).toBe('652J ACRIL BS - COBRE MEL');
  });
  it('nome de duas partes com sufixo BS tambem perde so o BS', () => {
    expect(textoDaCor(undefined, 'CINZA H155 - BS', 'BASE ACAB BRANC BRIL 20 WFOB.6501GL')).toBe('CINZA H155');
  });
  it('nao corta a propria cor quando a ultima parte nao e BS (Codex: PLATINA BIANCA)', () => {
    expect(textoDaCor(undefined, '346J - ACRIL BS - PLATINA BIANCA', 'BASE X')).toBe('346J - ACRIL BS - PLATINA BIANCA');
    expect(textoDaCor('1247', 'AZUL - PETROLEO', 'BASE GL')).toBe('1247 - AZUL - PETROLEO - GL');
  });
  it('id e nome: id primeiro, embalagem da descricao no fim', () => {
    expect(textoDaCor('1247', 'AZUL - BS', 'TINTA PU QT')).toBe('1247 - AZUL - QT');
  });
  it('so o id sai sozinho', () => {
    expect(textoDaCor('1247', undefined, 'TINTA')).toBe('1247');
  });
  it('sem id e sem nome (ou so espaco) nao ha linha de cor', () => {
    expect(textoDaCor(undefined, undefined, 'TINTA QT')).toBeNull();
    expect(textoDaCor('  ', '', 'TINTA QT')).toBeNull();
  });
  it('nome que e so o sufixo nao vira vazio', () => {
    expect(textoDaCor(undefined, 'X - BS', 'Y')).toBe('X');
    expect(textoDaCor(undefined, 'BS', 'Y')).toBe('BS');
  });
});
