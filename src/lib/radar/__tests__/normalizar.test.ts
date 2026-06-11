import { describe, expect, it } from 'vitest';
import {
  montarCnpj, normalizarData, normalizarTelefone, normalizarCapital,
  splitCnaesSecundarios, normalizarTexto, normalizarChaveMunicipio,
} from '../normalizar';

describe('montarCnpj', () => {
  it('compõe basico+ordem+dv com zero-pad', () =>
    expect(montarCnpj('123', '1', '44')).toBe('00000123000144'));
  it('rejeita componente não-numérico', () =>
    expect(montarCnpj('abc', '0001', '44')).toBeNull());
});

describe('normalizarData', () => {
  it('AAAAMMDD → YYYY-MM-DD', () => expect(normalizarData('20240115')).toBe('2024-01-15'));
  it('vazio/zero/lixo → null', () => {
    expect(normalizarData('')).toBeNull();
    expect(normalizarData('0')).toBeNull();
    expect(normalizarData('20241341')).toBeNull(); // mês 13 inexistente
  });
});

describe('normalizarTelefone', () => {
  it('junta ddd+numero', () => expect(normalizarTelefone('37', '32212222')).toBe('(37) 32212222'));
  it('sem ddd usa só o número; tudo vazio → null', () => {
    expect(normalizarTelefone('', '32212222')).toBe('32212222');
    expect(normalizarTelefone('', '')).toBeNull();
    expect(normalizarTelefone('0', '0')).toBeNull(); // placeholder da RFB
  });
});

describe('normalizarCapital', () => {
  it('vírgula decimal → number', () => expect(normalizarCapital('10000,50')).toBe(10000.5));
  it('ponto de milhar + vírgula decimal → number', () =>
    expect(normalizarCapital('1.500.000,00')).toBe(1500000));
  it('vazio/lixo → null', () => {
    expect(normalizarCapital('')).toBeNull();
    expect(normalizarCapital('abc')).toBeNull();
  });
});

describe('splitCnaesSecundarios', () => {
  it('lista com vírgula → array de 7 dígitos', () =>
    expect(splitCnaesSecundarios('1622602,2542000')).toEqual(['1622602', '2542000']));
  it('vazio e códigos malformados caem fora', () => {
    expect(splitCnaesSecundarios('')).toEqual([]);
    expect(splitCnaesSecundarios('123,1622602')).toEqual(['1622602']);
  });
});

describe('normalizarTexto', () => {
  it('trim + colapsa espaços; vazio → null', () => {
    expect(normalizarTexto('  MOVEIS  ZE  ')).toBe('MOVEIS ZE');
    expect(normalizarTexto('   ')).toBeNull();
  });
});

describe('normalizarChaveMunicipio', () => {
  it('casa nome RFB com nome IBGE (acentos, caixa, apóstrofo)', () => {
    expect(normalizarChaveMunicipio("SANTA BÁRBARA D'OESTE", 'SP'))
      .toBe(normalizarChaveMunicipio("Santa Barbara d Oeste", 'sp'));
  });
});
