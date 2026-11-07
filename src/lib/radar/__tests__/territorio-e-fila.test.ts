import { describe, it, expect } from 'vitest';
import {
  PERTO_DESLIGADO, cidadeDoTerritorioAtiva, lerTerritorio, patchMexeEmLugar, recorteDaCidade, territorioAutomatico,
  type MunicipioTerritorio,
} from '../territorio';
import { proximoDaFila } from '../fila';

const T: MunicipioTerritorio[] = [
  { municipioCodigo: '4123', municipioNome: 'DIVINOPOLIS', uf: 'MG', clientes: 12 },
  { municipioCodigo: '4567', municipioNome: 'NOVA SERRANA', uf: 'MG', clientes: 5 },
];
const SEM_LUGAR = { uf: '', municipio: '', municipioCodigo: '', regiao: 'atuacao', perto: '' };

describe('lerTerritorio (estrito: fora do formato LANÇA, nunca vira vazio)', () => {
  it('lê a resposta da RPC', () => {
    expect(lerTerritorio([{ municipio_codigo: '4123', municipio_nome: 'DIVINOPOLIS', uf: 'MG', clientes: 12 }], 'x'))
      .toEqual([T[0]]);
    expect(lerTerritorio([], 'x')).toEqual([]);
  });
  it.each([
    [null], [{}], [[{ municipio_codigo: '4123', municipio_nome: 'X', uf: 'MG', clientes: 0 }]],
    [[{ municipio_codigo: '3122306', municipio_nome: 'X', uf: 'MG', clientes: 1 }]],
    [[{ municipio_codigo: '4123', municipio_nome: '', uf: 'MG', clientes: 1 }]],
  ])('recusa %j com a marca do formato', (d) => {
    expect(() => lerTerritorio(d, 'radar_meu_territorio')).toThrow(/radar_meu_territorio: resposta fora do formato/);
  });
});

describe('territorioAutomatico', () => {
  it('com território e sem lugar na URL → a cidade nº 1', () => {
    expect(territorioAutomatico(SEM_LUGAR, T)).toEqual(T[0]);
  });
  it('sem território (staff, master) ou leitura ausente → null (default de antes)', () => {
    expect(territorioAutomatico(SEM_LUGAR, [])).toBeNull();
    expect(territorioAutomatico(SEM_LUGAR, null)).toBeNull();
    expect(territorioAutomatico(SEM_LUGAR, undefined)).toBeNull();
  });
  it.each([
    [{ uf: 'SP' }], [{ municipio: 'ITAUNA' }], [{ municipioCodigo: '9999' }], [{ regiao: 'brasil' }], [{ perto: PERTO_DESLIGADO }],
  ])('lugar explícito %j vence o automático', (patch) => {
    expect(territorioAutomatico({ ...SEM_LUGAR, ...patch }, T)).toBeNull();
  });
});

describe('recorte e chips', () => {
  it('recorteDaCidade leva a UF junto (cidade fora de "MG e vizinhos" não vira fila vazia)', () => {
    expect(recorteDaCidade({ municipioCodigo: '7535', municipioNome: 'CURITIBA', uf: 'PR', clientes: 2 }))
      .toEqual({ municipio: 'CURITIBA', municipioCodigo: '7535', uf: 'PR', regiao: 'atuacao' });
  });
  it('cidadeDoTerritorioAtiva casa pelo código', () => {
    expect(cidadeDoTerritorioAtiva('4567', T)).toEqual(T[1]);
    expect(cidadeDoTerritorioAtiva('0001', T)).toBeNull();
    expect(cidadeDoTerritorioAtiva('', T)).toBeNull();
  });
  it('patchMexeEmLugar', () => {
    expect(patchMexeEmLugar({ municipio: '' })).toBe(true);
    expect(patchMexeEmLugar({ regiao: 'brasil', municipioCodigo: '' })).toBe(true);
    expect(patchMexeEmLugar({ cnae: '3101' })).toBe(false);
  });
});

describe('proximoDaFila — ficha aberta FORA da fila (pacote F, achado 6)', () => {
  const fila = [{ cnpj: 'A' }, { cnpj: 'B' }];
  it('fila [A,B] + ficha Z (link do e-mail) → abre A, não "fim"', () => {
    expect(proximoDaFila(fila, 'Z', null, false)).toEqual({ tipo: 'abrir', empresa: { cnpj: 'A' }, indice: 0 });
  });
  it('Z fora da fila e fila vazia → fim / buscar_mais', () => {
    expect(proximoDaFila([], 'Z', null, false)).toEqual({ tipo: 'fim' });
    expect(proximoDaFila([], 'Z', null, true)).toEqual({ tipo: 'buscar_mais' });
  });
  it('o aberto saiu da lista (contato registrado) → o que ocupou a posição dele (comportamento de antes)', () => {
    expect(proximoDaFila([{ cnpj: 'A' }, { cnpj: 'C' }], 'B', 1, false)).toEqual({ tipo: 'abrir', empresa: { cnpj: 'C' }, indice: 1 });
  });
  it('fim de verdade continua sendo fim (nunca volta ao 1º de uma fila já percorrida)', () => {
    expect(proximoDaFila(fila, 'B', 1, false)).toEqual({ tipo: 'fim' });
    expect(proximoDaFila([{ cnpj: 'A' }], 'B', 1, false)).toEqual({ tipo: 'fim' });
  });
});
