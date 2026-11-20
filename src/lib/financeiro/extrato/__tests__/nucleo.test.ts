import { describe, it, expect } from 'vitest';
import {
  chavesDasLinhas,
  decimalTextoParaCentavos,
  fecha,
  normalizarDescricao,
  soDigitos,
  type LinhaExtrato,
} from '../nucleo';

function l(p: Partial<LinhaExtrato> = {}): LinhaExtrato {
  return {
    data: '2026-11-03',
    sentido: 'D',
    valorCentavos: 1000,
    descricao: 'TARIFA',
    documento: null,
    idBancario: null,
    ...p,
  };
}

describe('decimalTextoParaCentavos', () => {
  it.each([
    ['1234.56', 123456],
    ['-1234.56', 123456],
    ['-0.01', 1],
    ['1.234,56', 123456],
    ['1234,56', 123456],
    ['10', 1000],
    ['0,5', 50],
    ['12.5', 1250],
  ])('%s -> %s', (entrada, esperado) => {
    expect(decimalTextoParaCentavos(entrada)).toBe(esperado);
  });

  it.each([['12.345'], [''], ['  '], ['abc'], ['1,234,56'], ['1.234.567'], ['1,234'], ['1.2345'], ['NaN'], ['-']])(
    '%j -> null',
    (entrada) => {
      expect(decimalTextoParaCentavos(entrada)).toBeNull();
    },
  );

  it('não sofre erro de ponto flutuante', () => {
    expect(decimalTextoParaCentavos('0.29')).toBe(29);
    expect(decimalTextoParaCentavos('1.15')).toBe(115);
    expect(decimalTextoParaCentavos('4.35')).toBe(435);
  });
});

describe('normalizarDescricao / soDigitos', () => {
  it('trim, colapsa espaços, maiúsculas, sem acento', () => {
    expect(normalizarDescricao('  Pagamento   Açúcar  ')).toBe('PAGAMENTO ACUCAR');
  });
  it('soDigitos', () => {
    expect(soDigitos('12.345-6')).toBe('123456');
  });
});

describe('chavesDasLinhas', () => {
  it('2 tarifas idênticas -> sufixos |1 e |2; ordem invertida mantém o conjunto', () => {
    const a = [l(), l()];
    const chaves = chavesDasLinhas(a, 'tupla')!;
    expect(chaves[0].endsWith('|1')).toBe(true);
    expect(chaves[1].endsWith('|2')).toBe(true);
    expect(new Set(chavesDasLinhas([...a].reverse(), 'tupla'))).toEqual(new Set(chaves));
  });

  it('formato da chave tupla e id_bancario', () => {
    expect(chavesDasLinhas([l({ documento: 'X1' })], 'tupla')).toEqual(['2026-11-03|D|1000|X1|1']);
    expect(chavesDasLinhas([l({ idBancario: 'ABC' })], 'id_bancario')).toEqual(['id:ABC']);
  });

  it('descrição diferente -> mesma chave tupla', () => {
    expect(chavesDasLinhas([l({ descricao: 'A' })], 'tupla')).toEqual(chavesDasLinhas([l({ descricao: 'B' })], 'tupla'));
  });

  it('estorno (D 500 e C 500 no mesmo dia) -> 2 chaves distintas', () => {
    const chaves = chavesDasLinhas([l({ valorCentavos: 500 }), l({ valorCentavos: 500, sentido: 'C' })], 'tupla')!;
    expect(new Set(chaves).size).toBe(2);
  });

  it("'id_bancario' -> null se faltar id (null ou vazio) ou repetir", () => {
    expect(chavesDasLinhas([l({ idBancario: 'A' }), l()], 'id_bancario')).toBeNull();
    expect(chavesDasLinhas([l({ idBancario: '' })], 'id_bancario')).toBeNull();
    expect(chavesDasLinhas([l({ idBancario: 'A' }), l({ idBancario: 'A' })], 'id_bancario')).toBeNull();
  });

  it('propriedade: 200 permutações (PRNG semeado) não mudam o conjunto de chaves', () => {
    let s = 0x9e3779b9;
    const rnd = () => {
      // mulberry32
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const base: LinhaExtrato[] = [];
    for (let i = 0; i < 12; i++) {
      base.push(
        l({
          data: `2026-11-0${1 + Math.floor(rnd() * 3)}`,
          sentido: rnd() < 0.5 ? 'C' : 'D',
          valorCentavos: 100 * (1 + Math.floor(rnd() * 3)),
          documento: rnd() < 0.5 ? 'D1' : null,
        }),
      );
    }
    const ref = new Set(chavesDasLinhas(base, 'tupla'));
    for (let k = 0; k < 200; k++) {
      const p = [...base];
      for (let i = p.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
      }
      expect(new Set(chavesDasLinhas(p, 'tupla'))).toEqual(ref);
    }
  });
});

describe('fecha', () => {
  const linhas = [l({ sentido: 'C', valorCentavos: 500 }), l({ sentido: 'D', valorCentavos: 200 })];
  it('fecha quando bate', () => {
    expect(fecha(10000, linhas, 10300)).toEqual({ fecha: true, diferencaCentavos: 0 });
  });
  it('diferença de 1 centavo', () => {
    const r = fecha(10000, linhas, 10301);
    expect(r.fecha).toBe(false);
    expect(r.diferencaCentavos).toBe(1);
  });
});
