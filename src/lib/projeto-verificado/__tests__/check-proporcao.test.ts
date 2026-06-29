import { describe, it, expect } from 'vitest';
import { avaliarProporcao, type ItemCesta, type RequisitoSistema } from '../check-proporcao';

// Sistema-exemplo (valores de TESTE — os reais vêm do discovery D3):
// para cada 1 L de acabamento, exige 1 L de fundo, 0,1 L de catalisador.
const sistema: RequisitoSistema = {
  proporcaoMinima: { fundo: 1.0, catalisador: 0.1 },
};

describe('avaliarProporcao', () => {
  it('atende quando a cesta (toda Colacor) cobre a proporção mínima', () => {
    const cesta: ItemCesta[] = [
      { tipo: 'acabamento', litros: 4, origem: 'colacor' },
      { tipo: 'fundo', litros: 4, origem: 'colacor' },
      { tipo: 'catalisador', litros: 0.5, origem: 'colacor' },
    ];
    const r = avaliarProporcao(cesta, sistema);
    expect(r.litrosAcabamento).toBe(4);
    expect(r.atende).toBe(true);
    expect(r.faltantes).toEqual([]);
    expect(r.temComponenteExterno).toBe(false);
  });

  it('NÃO atende e lista o faltante quando o fundo é insuficiente', () => {
    const cesta: ItemCesta[] = [
      { tipo: 'acabamento', litros: 4, origem: 'colacor' },
      { tipo: 'fundo', litros: 1, origem: 'colacor' }, // exige 4
      { tipo: 'catalisador', litros: 0.5, origem: 'colacor' },
    ];
    const r = avaliarProporcao(cesta, sistema);
    expect(r.atende).toBe(false);
    expect(r.faltantes).toEqual([{ tipo: 'fundo', requeridoL: 4, presenteL: 1 }]);
  });

  it('ignora litros de componente EXTERNO ao checar proporção e sinaliza o externo', () => {
    const cesta: ItemCesta[] = [
      { tipo: 'acabamento', litros: 4, origem: 'colacor' },
      { tipo: 'fundo', litros: 4, origem: 'externo' }, // comprado fora → não conta
      { tipo: 'catalisador', litros: 0.5, origem: 'colacor' },
    ];
    const r = avaliarProporcao(cesta, sistema);
    expect(r.atende).toBe(false);
    expect(r.faltantes).toEqual([{ tipo: 'fundo', requeridoL: 4, presenteL: 0 }]);
    expect(r.temComponenteExterno).toBe(true);
  });

  it('sem acabamento na cesta → não atende, sem inventar (litrosAcabamento 0)', () => {
    const cesta: ItemCesta[] = [{ tipo: 'fundo', litros: 4, origem: 'colacor' }];
    const r = avaliarProporcao(cesta, sistema);
    expect(r.litrosAcabamento).toBe(0);
    expect(r.atende).toBe(false);
    expect(r.faltantes).toEqual([]);
  });
});
