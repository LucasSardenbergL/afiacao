import { describe, it, expect } from 'vitest';
import { ufsDe, filtrarCidadesPorUf } from './city-filter';
import type { CityOption } from '@/components/reposicao/routePlanner/types';

const mk = (codigo: string, nome: string, uf: string): CityOption => ({
  codigo, nome, uf, total: 0, comTelefone: 0, aContatar: 0,
});

describe('ufsDe', () => {
  it('UFs distintas, ordenadas, uppercase, sem vazios', () => {
    const cidades = [mk('1', 'Divinópolis', 'mg'), mk('2', 'Itaúna', 'MG'), mk('3', 'Bauru', 'SP'), mk('4', 'X', '  ')];
    expect(ufsDe(cidades)).toEqual(['MG', 'SP']);
  });
  it('vazio → vazio', () => {
    expect(ufsDe([])).toEqual([]);
  });
});

describe('filtrarCidadesPorUf', () => {
  const cidades = [mk('1', 'Divinópolis', 'MG'), mk('2', 'Bauru', 'SP')];
  it('uf null → todas', () => {
    expect(filtrarCidadesPorUf(cidades, null)).toHaveLength(2);
  });
  it('filtra pela uf (case-insensitive)', () => {
    expect(filtrarCidadesPorUf(cidades, 'mg').map((c) => c.codigo)).toEqual(['1']);
  });
});
