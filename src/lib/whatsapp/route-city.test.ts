import { describe, it, expect } from 'vitest';
import { normalizeCityKey, cityKeyEquals } from './route-city';

describe('normalizeCityKey', () => {
  it('extrai cidade e UF do formato "FORMIGA (MG)"', () => {
    expect(normalizeCityKey('FORMIGA (MG)')).toEqual({ city: 'FORMIGA', uf: 'MG' });
  });
  it('tira acento e normaliza caixa: "Divinópolis/MG"', () => {
    expect(normalizeCityKey('Divinópolis/MG')).toEqual({ city: 'DIVINOPOLIS', uf: 'MG' });
  });
  it('preserva UF do Tocantins (não vira MG): "Divinópolis (TO)"', () => {
    expect(normalizeCityKey('Divinópolis (TO)')).toEqual({ city: 'DIVINOPOLIS', uf: 'TO' });
  });
  it('cidade sem UF retorna uf vazio: "Pitangui"', () => {
    expect(normalizeCityKey('Pitangui')).toEqual({ city: 'PITANGUI', uf: '' });
  });
  it('aceita UF como sufixo separado por espaço: "Pará de Minas MG"', () => {
    expect(normalizeCityKey('Pará de Minas MG')).toEqual({ city: 'PARA DE MINAS', uf: 'MG' });
  });
  it('retorna null para vazio/lixo', () => {
    expect(normalizeCityKey(null)).toBeNull();
    expect(normalizeCityKey('')).toBeNull();
    expect(normalizeCityKey('   ')).toBeNull();
    expect(normalizeCityKey('(MG)')).toBeNull();
  });
});

describe('cityKeyEquals', () => {
  const formiga = { city: 'FORMIGA', uf: 'MG' };
  it('casa cidade+UF iguais', () => {
    expect(cityKeyEquals(formiga, { city: 'FORMIGA', uf: 'MG' })).toBe(true);
  });
  it('NÃO casa Divinópolis MG x TO (ambos têm UF)', () => {
    expect(cityKeyEquals({ city: 'DIVINOPOLIS', uf: 'MG' }, { city: 'DIVINOPOLIS', uf: 'TO' })).toBe(false);
  });
  it('casa por cidade quando um lado não tem UF (cadastro incompleto)', () => {
    expect(cityKeyEquals(formiga, { city: 'FORMIGA', uf: '' })).toBe(true);
  });
  it('não casa cidades diferentes', () => {
    expect(cityKeyEquals(formiga, { city: 'PIMENTA', uf: 'MG' })).toBe(false);
  });
});
