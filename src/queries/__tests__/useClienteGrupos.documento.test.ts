import { describe, it, expect } from 'vitest';
import { avaliarDocumento, documentoValido, normalizarDocumento } from '../useClienteGrupos';

// Espelho TS do CHECK `cliente_grupo_membros_documento_formato` (migration 20261020130000) + a regra do diálogo.
// Oráculos: o exemplo OFICIAL da RFB (12.ABC.345/01DE-35) e o contraexemplo P1 do Codex (AEG12345678908 → dígitos
// = CPF de OUTRA pessoa). O numérico carrega o comportamento ANTIGO como oráculo (só-dígitos, 11 ou 14).

describe('normalizarDocumento (grupos): numérico byte-idêntico ao só-dígitos de sempre', () => {
  it.each([
    ['12.345.678/0001-90', '12345678000190'],
    ['123.456.789-09', '12345678909'],
    ['CNPJ: 12345678000190', '12345678000190'],
    [' 12345678000190 ', '12345678000190'],
    ['aeg-123.456.789-09', '12345678909'],
    ['', ''],
  ])('%s → %s', (bruto, chave) => {
    expect(normalizarDocumento(bruto)).toBe(bruto.replace(/\D/g, ''));
    expect(normalizarDocumento(bruto)).toBe(chave);
  });
});

describe('avaliarDocumento: CNPJ alfanumérico', () => {
  it('exemplo oficial da RFB entra, cru ou com máscara, maiúsculo ou minúsculo', () => {
    for (const bruto of ['12ABC34501DE35', '12.ABC.345/01DE-35', '12abc34501de35', '12.abc.345/01de-35', ' 12.ABC.345/01DE-35 ']) {
      expect(avaliarDocumento(bruto)).toEqual({ chave: '12ABC34501DE35', motivo: 'ok' });
      expect(documentoValido(bruto)).toBe(true);
    }
  });

  it('DV errado com a FORMA de alfanumérico é recusado como tal — não cai nos dígitos', () => {
    expect(avaliarDocumento('12ABC34501DE36').motivo).toBe('dv_alfanumerico');
    expect(avaliarDocumento('12.ABC.345/01DE-36').motivo).toBe('dv_alfanumerico');
    // P1 do Codex (2026-10-20): os dígitos de AEG12345678908 são 12345678908 (11) — seria aceito como CPF de outrem
    expect(avaliarDocumento('AEG12345678908')).toEqual({ chave: '12345678908', motivo: 'dv_alfanumerico' });
    expect(documentoValido('AEG12345678908')).toBe(false);
  });

  it('AEG12345678909 (DV confere) é alfanumérico válido — chave com as letras, não o CPF 12345678909', () => {
    expect(avaliarDocumento('AEG12345678909')).toEqual({ chave: 'AEG12345678909', motivo: 'ok' });
  });

  it('letra FORA da forma (anotação, máscara fora de posição) continua caindo nos dígitos, como sempre', () => {
    expect(avaliarDocumento('aeg-123.456.789-09')).toEqual({ chave: '12345678909', motivo: 'ok' });
    expect(avaliarDocumento('CNPJ: 12.345.678/0001-90')).toEqual({ chave: '12345678000190', motivo: 'ok' });
    expect(avaliarDocumento('aeg 123.456.789-09')).toEqual({ chave: '12345678909', motivo: 'ok' });
  });

  it('tamanho errado é "tamanho" (10, 12 e 13 dígitos; vazio)', () => {
    for (const bruto of ['1234567890', '123456789012', '1234567890123', '', 'abc']) {
      expect(avaliarDocumento(bruto).motivo).toBe('tamanho');
      expect(documentoValido(bruto)).toBe(false);
    }
  });
});
