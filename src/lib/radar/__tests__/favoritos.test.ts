import { describe, it, expect } from 'vitest';
import {
  chaveFavoritos, comFavorito, gravarFavoritos, lerFavoritos, mesmosFiltros, sanitizarFiltros, MAX_FAVORITOS,
  type FiltrosSalvos,
} from '../favoritos';

const PADRAO: FiltrosSalvos = { busca: '', uf: '', cnae: '', regiao: 'atuacao', incluirSemContato: false, preset: 'score' };

function memoria(inicial: Record<string, string> = {}) {
  const m = new Map(Object.entries(inicial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    m,
  };
}

describe('favoritos de filtro do Radar', () => {
  it('chave por usuário: um não lê o do outro', () => {
    const s = memoria({ [chaveFavoritos('u1')]: JSON.stringify([{ nome: 'A', filtros: { uf: 'MG' } }]) });
    expect(lerFavoritos(s, 'u1', PADRAO)).toHaveLength(1);
    expect(lerFavoritos(s, 'u2', PADRAO)).toEqual([]);
  });

  it('JSON quebrado, forma estranha ou storage que LANÇA: lista vazia, sem estourar a tela', () => {
    expect(lerFavoritos(memoria({ [chaveFavoritos('u')]: '{quebrado' }), 'u', PADRAO)).toEqual([]);
    expect(lerFavoritos(memoria({ [chaveFavoritos('u')]: '{"a":1}' }), 'u', PADRAO)).toEqual([]);
    const lanca = { getItem: () => { throw new Error('SecurityError'); } };
    expect(lerFavoritos(lanca, 'u', PADRAO)).toEqual([]);
    expect(lerFavoritos(null, 'u', PADRAO)).toEqual([]);
  });

  it('sanitiza: só chaves conhecidas, com o tipo do default; o resto volta ao default', () => {
    const f = sanitizarFiltros({ uf: 'SP', incluirSemContato: 'sim', estranha: 1, preset: 'novas' }, PADRAO);
    expect(f).toEqual({ ...PADRAO, uf: 'SP', preset: 'novas' });
    expect(sanitizarFiltros(null, PADRAO)).toEqual(PADRAO);
  });

  it('descarta favorito sem nome', () => {
    const s = memoria({ [chaveFavoritos('u')]: JSON.stringify([{ nome: '  ', filtros: {} }, { nome: 'Ok', filtros: {} }]) });
    expect(lerFavoritos(s, 'u', PADRAO).map((f) => f.nome)).toEqual(['Ok']);
  });

  it('mesmo nome (sem caixa) substitui e sobe ao topo; teto de favoritos', () => {
    let l = comFavorito([], 'Moveleiro MG', { ...PADRAO, cnae: '3101-2/00' });
    l = comFavorito(l, 'Marmorarias', { ...PADRAO, cnae: '2391-5/03' });
    l = comFavorito(l, 'moveleiro mg', { ...PADRAO, cnae: '3101' });
    expect(l.map((f) => f.nome)).toEqual(['moveleiro mg', 'Marmorarias']);
    for (let i = 0; i < MAX_FAVORITOS + 5; i++) l = comFavorito(l, `f${i}`, PADRAO);
    expect(l).toHaveLength(MAX_FAVORITOS);
  });

  it('gravar devolve false quando o storage recusa (cheio/bloqueado)', () => {
    const s = memoria();
    expect(gravarFavoritos(s, 'u', [{ nome: 'A', filtros: PADRAO }])).toBe(true);
    expect(lerFavoritos(s, 'u', PADRAO)).toEqual([{ nome: 'A', filtros: PADRAO }]);
    const cheio = { setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(gravarFavoritos(cheio, 'u', [])).toBe(false);
  });

  it('mesmosFiltros compara valor a valor', () => {
    expect(mesmosFiltros(PADRAO, { ...PADRAO })).toBe(true);
    expect(mesmosFiltros(PADRAO, { ...PADRAO, uf: 'MG' })).toBe(false);
  });
});
