import { describe, expect, it } from 'vitest';
import {
  montarCnpj, normalizarData, normalizarTelefone, normalizarCapital,
  splitCnaesSecundarios, normalizarTexto, normalizarChaveMunicipio,
  CNPJ_RE, dvCnpj, cnpjValido,
} from '../normalizar';

// Oráculo externo: o exemplo OFICIAL da RFB para o CNPJ alfanumérico é 12.ABC.345/01DE-35
// (manual do CNPJ alfanumérico, jul/2026). Se o algoritmo divergir dele, o teste é quem avisa.
const RFB_EXEMPLO_BASE = '12ABC34501DE';
const RFB_EXEMPLO_DV = '35';

describe('dvCnpj — módulo 11 sobre ASCII-48 (regra RFB jul/2026)', () => {
  it('reproduz o exemplo oficial da RFB (12.ABC.345/01DE-35)', () =>
    expect(dvCnpj(RFB_EXEMPLO_BASE)).toBe(RFB_EXEMPLO_DV));
  it('para base só-numérica coincide com a regra clássica (dígito = valor)', () =>
    expect(dvCnpj('000001230001')).toBe('22'));
  it('resto < 2 vira DV 0 (caso 99888777 0001 → 00)', () =>
    expect(dvCnpj('998887770001')).toBe('00'));
  it('base com tamanho errado ou caractere fora de [0-9A-Z] → null', () => {
    expect(dvCnpj('12ABC34501D')).toBeNull();
    expect(dvCnpj('12abc34501DE')).toBeNull();
    expect(dvCnpj('12ABC34501D-')).toBeNull();
  });
});

describe('CNPJ_RE / cnpjValido', () => {
  it('formato: 12 posições [0-9A-Z] + 2 dígitos', () => {
    expect(CNPJ_RE.test('12ABC34501DE35')).toBe(true);
    expect(CNPJ_RE.test('00000123000122')).toBe(true);
    expect(CNPJ_RE.test('12ABC34501DE3A')).toBe(false); // DV com letra
    expect(CNPJ_RE.test('12abc34501DE35')).toBe(false); // minúscula
    expect(CNPJ_RE.test('12ABC34501DE3')).toBe(false);  // 13
  });
  it('cnpjValido exige formato E DV', () => {
    expect(cnpjValido('12ABC34501DE35')).toBe(true);
    expect(cnpjValido('00000123000122')).toBe(true);
    expect(cnpjValido('12ABC34501DE36')).toBe(false); // DV errado
    expect(cnpjValido('00000123000144')).toBe(false); // DV errado numérico
    expect(cnpjValido('12abc34501DE35')).toBe(false); // minúscula
  });
});

describe('montarCnpj', () => {
  it('compõe basico+ordem+dv com zero-pad (numérico, DV válido)', () =>
    expect(montarCnpj('123', '1', '22')).toBe('00000123000122'));
  it('aceita componentes alfanuméricos maiúsculos (exemplo oficial RFB)', () =>
    expect(montarCnpj('12ABC345', '01DE', '35')).toBe('12ABC34501DE35'));
  it('zero-pad também vale para componente alfanumérico curto', () =>
    expect(montarCnpj('ABC', '1DE', dvCnpj('00000ABC01DE')!)).toBe(`00000ABC01DE${dvCnpj('00000ABC01DE')}`));
  it('rejeita DV inválido (numérico e alfanumérico) — fail-closed', () => {
    expect(montarCnpj('123', '1', '44')).toBeNull();
    expect(montarCnpj('12ABC345', '01DE', '36')).toBeNull();
  });
  it('rejeita letra minúscula (o dump RFB é maiúsculo; não normaliza)', () =>
    expect(montarCnpj('12abc345', '01DE', '35')).toBeNull());
  it('rejeita DV não-numérico e caractere fora de [0-9A-Z]', () => {
    expect(montarCnpj('12ABC345', '01DE', '3A')).toBeNull();
    expect(montarCnpj('12-BC345', '01DE', '35')).toBeNull();
    expect(montarCnpj('', '0001', '22')).toBeNull();
  });
});

describe('normalizarData', () => {
  it('AAAAMMDD → YYYY-MM-DD', () => expect(normalizarData('20240115')).toBe('2024-01-15'));
  it('vazio/zero/lixo → null', () => {
    expect(normalizarData('')).toBeNull();
    expect(normalizarData('0')).toBeNull();
    expect(normalizarData('20241341')).toBeNull(); // mês 13 inexistente
  });
  // Fix M2: branch '00000000' documentada com teste
  it('00000000 → null', () => expect(normalizarData('00000000')).toBeNull());
  // Fix C1: dia-no-mês real (derruba chunk no Postgres sem essa validação)
  it('dia inválido no mês → null', () => {
    expect(normalizarData('20240231')).toBeNull(); // fev não tem 31
    expect(normalizarData('20230229')).toBeNull(); // 2023 não é bissexto
  });
  it('bissexto válido passa', () => expect(normalizarData('20240229')).toBe('2024-02-29'));
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
  // Fix I1: caracteres de controle (NUL, tabs, newlines) derrubam chunk no Postgres
  it('strip de caracteres de controle', () =>
    expect(normalizarTexto('EMPRESA\x00X')).toBe('EMPRESA X'));
});

describe('normalizarChaveMunicipio', () => {
  // Teste antigo — atualiza o esperado: chave agora SEM espaços (Fix I2+I3)
  it('casa nome RFB com nome IBGE (acentos, caixa, apóstrofo)', () => {
    expect(normalizarChaveMunicipio("SANTA BÁRBARA D'OESTE", 'SP'))
      .toBe(normalizarChaveMunicipio("Santa Barbara d Oeste", 'sp'));
  });
  // Fix I2: literal esperado com chave sem espaços
  it('literal: SANTA BÁRBARA D\'OESTE → SANTABARBARADOESTE|SP', () =>
    expect(normalizarChaveMunicipio("SANTA BÁRBARA D'OESTE", 'SP'))
      .toBe('SANTABARBARADOESTE|SP'));
  // Fix I3: D'ÁGUA colado (RFB) == DAGUA separado (IBGE)
  it("OLHO-D'ÁGUA DO BORGES == OLHO DAGUA DO BORGES", () =>
    expect(normalizarChaveMunicipio("OLHO-D'ÁGUA DO BORGES", 'RN'))
      .toBe(normalizarChaveMunicipio('OLHO DAGUA DO BORGES', 'rn')));
});
