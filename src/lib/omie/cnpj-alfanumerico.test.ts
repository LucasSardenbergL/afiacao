import { describe, it, expect } from 'vitest';
import { CNPJ_RE, cnpjValido, dvCnpj, ehCnpjAlfanumerico, normalizarDocumento } from './cnpj-alfanumerico';

// Espelho vitest de `supabase/functions/_shared/cnpj-alfanumerico_test.ts` — MESMOS casos, mesmo oráculo
// (exemplo OFICIAL da RFB 12.ABC.345/01DE-35). Se um dos dois divergir, foi o espelho que quebrou.
describe('cnpj-alfanumerico (espelho src/ do _shared/)', () => {
  it('dvCnpj reproduz o exemplo oficial da RFB e a regra clássica no numérico', () => {
    expect(dvCnpj('12ABC34501DE')).toBe('35');
    expect(dvCnpj('000001230001')).toBe('22');
    expect(dvCnpj('998887770001')).toBe('00');
    expect(dvCnpj('12abc34501DE')).toBeNull();
  });

  it('cnpjValido: formato E DV; minúscula é inválida no validador cru', () => {
    expect(cnpjValido('12ABC34501DE35')).toBe(true);
    expect(cnpjValido('12ABC34501DE36')).toBe(false);
    expect(cnpjValido('12abc34501DE35')).toBe(false);
    expect(CNPJ_RE.test('12ABC34501DE3A')).toBe(false);
  });

  it('numérico: byte-idêntico ao só-dígitos (máscara, espaços, vazio, null, rótulo, lixo)', () => {
    const casos: unknown[] = [
      '12.345.678/0001-90', '12345678000190', '123.456.789-09', '12345678909', ' 12.345.678/0001-90 ',
      '', null, undefined, 'CPF: 123.456.789-09', 'abc', '12 345', '1234567800019A', '12345678000191',
    ];
    for (const c of casos) expect(normalizarDocumento(c), `caso ${JSON.stringify(c)}`).toBe(String(c ?? '').replace(/\D/g, ''));
  });

  it('alfanumérico válido: preserva letras, tira máscara, sobe caixa — e satisfaz o regex do recruzar', () => {
    for (const c of ['12.ABC.345/01DE-35', '12ABC34501DE35', '12abc34501de35', '  12.abc.345/01de-35\n']) {
      expect(normalizarDocumento(c)).toBe('12ABC34501DE35');
    }
    expect(CNPJ_RE.test(normalizarDocumento('12.ABC.345/01DE-35'))).toBe(true);
    expect(ehCnpjAlfanumerico('12ABC34501DE35')).toBe(true);
  });

  it('alfanumérico inválido (DV/formato/espaço interno) → só-dígitos como antes', () => {
    expect(normalizarDocumento('12.ABC.345/01DE-36')).toBe('123450136');
    expect(normalizarDocumento('12ABC34501DE3')).toBe('12345013');
    expect(normalizarDocumento('12 ABC34501DE35')).toBe('123450135');
    expect(ehCnpjAlfanumerico('123450136')).toBe(false);
    expect(ehCnpjAlfanumerico('12345678000190')).toBe(false);
  });

  // Invariante 3 (Codex retroativo do #3175, PR #3192): separador só conta na POSIÇÃO EXATA da máscara —
  // "aeg-123.456.789-09" (CPF anotado) virava AEG12345678909, DV válido por coincidência. Espelha
  // `normalizar_documento()` (migration 20261019140000) e `radar_recruzar_ja_cliente()` (20261019150000).
  it('máscara exata: separador fora da posição da máscara NÃO cola um CNPJ alfanumérico', () => {
    expect(normalizarDocumento('aeg-123.456.789-09')).toBe('12345678909');
    expect(normalizarDocumento('AEG-123.456.789-09')).toBe('12345678909');
    expect(normalizarDocumento('12ABC.34501DE-35')).toBe('123450135');
    expect(normalizarDocumento('12.ABC.345/01DE-35')).toBe('12ABC34501DE35');
    expect(normalizarDocumento('12ABC34501DE35')).toBe('12ABC34501DE35');
    expect(normalizarDocumento('12-ABC-345-01DE-35')).toBe('123450135');
    expect(normalizarDocumento('12.ABC.345/01DE-35.')).toBe('123450135');
    // Prova de que o caso é real: o resultado inflado de antes ERA um CNPJ alfanumérico válido.
    expect(ehCnpjAlfanumerico('AEG12345678909')).toBe(true);
  });
});
