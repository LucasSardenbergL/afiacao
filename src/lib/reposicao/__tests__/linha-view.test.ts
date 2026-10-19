import { describe, expect, it } from 'vitest';
import { exigirColunas, exigirEmpresaReposicao, linhasCom } from '../linha-view';

type Linha = { id: number | null; nome: string | null; obs: string | null };

describe('linha-view — borda das views que perdem o NOT NULL', () => {
  it('estreita as colunas exigidas e deixa as outras como vieram', () => {
    const l: Linha = { id: 1, nome: 'a', obs: null };
    exigirColunas(l, ['id', 'nome'], 'v_x');
    const id: number = l.id; // compila só se estreitou
    const nome: string = l.nome;
    expect([id, nome, l.obs]).toEqual([1, 'a', null]);
  });

  it('lança nomeando fonte e coluna quando a exigida vem nula (ausente ≠ zero)', () => {
    expect(() => exigirColunas({ id: null, nome: 'a', obs: null } as Linha, ['id'], 'v_x')).toThrow(
      'v_x: coluna "id" veio nula',
    );
    expect(() => exigirColunas({ id: 1, nome: undefined as unknown as null, obs: null } as Linha, ['nome'], 'v_x')).toThrow(
      'coluna "nome"',
    );
  });

  it('linhasCom: lista nula vira vazia; linha inválida no meio derruba a lista inteira', () => {
    expect(linhasCom<Linha, 'id'>(null, ['id'], 'v_x')).toEqual([]);
    const ok = linhasCom<Linha, 'id'>([{ id: 1, nome: null, obs: null }], ['id'], 'v_x');
    expect(ok[0].id + 1).toBe(2);
    expect(() =>
      linhasCom<Linha, 'id'>([{ id: 1, nome: null, obs: null }, { id: null, nome: 'b', obs: null }], ['id'], 'v_x'),
    ).toThrow('v_x: coluna "id"');
  });

  it('exigirEmpresaReposicao aceita só OBEN/COLACOR', () => {
    expect(exigirEmpresaReposicao('OBEN', 'f')).toBe('OBEN');
    expect(() => exigirEmpresaReposicao('oben', 'f')).toThrow('fora de OBEN/COLACOR');
    expect(() => exigirEmpresaReposicao(null, 'f')).toThrow('f: empresa "null"');
  });
});
