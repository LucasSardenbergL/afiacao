import { describe, it, expect } from 'vitest';
import { classificarConsumo, type ParametrosConsumo } from '../consumo';

// Sistema-exemplo: rende 10 m²/L. 40 m² → esperado 4 L.
const p = (over: Partial<ParametrosConsumo>): ParametrosConsumo => ({
  areaM2: 40,
  rendimentoM2PorLitro: 10,
  litrosDosados: 4,
  ...over,
});

describe('classificarConsumo', () => {
  it('volume na faixa do esperado → compativel', () => {
    const r = classificarConsumo(p({ litrosDosados: 4 }));
    expect(r.esperadoL).toBe(4);
    expect(r.classe).toBe('compativel');
  });

  it('até 30% abaixo ainda é compativel (banda ampla)', () => {
    const r = classificarConsumo(p({ litrosDosados: 3 })); // razão 0,75
    expect(r.classe).toBe('compativel');
  });

  it('entre 40% e 70% do esperado → baixo', () => {
    const r = classificarConsumo(p({ litrosDosados: 2 })); // razão 0,5
    expect(r.classe).toBe('baixo');
  });

  it('abaixo de 40% do esperado → suspeito', () => {
    const r = classificarConsumo(p({ litrosDosados: 1 })); // razão 0,25
    expect(r.classe).toBe('suspeito');
  });

  it('rendimento inválido → indeterminado (não fabrica classe)', () => {
    const r = classificarConsumo(p({ rendimentoM2PorLitro: 0 }));
    expect(r.classe).toBe('indeterminado');
    expect(r.esperadoL).toBeNull();
    expect(r.razao).toBeNull();
  });
});
