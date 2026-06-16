import { describe, it, expect } from 'vitest';
import { chaveDiaExibidaCaca, resumoSabores } from '../telemetria';
import type { CacaCandidatoDisplay } from '../types';

function display(sabor: CacaCandidatoDisplay['sabor']): CacaCandidatoDisplay {
  return {
    features: {
      documento: '1',
      empresaAlvo: 'oben',
      cidadeUf: null,
      ramo: null,
      ticketFaixa: null,
      familias: [],
      compraEmOutraEmpresa: sabor === 'cross_empresa',
      compraNaEmpresaAlvo: false,
      ultimaCompraGrupoDias: sabor === 'frio' ? null : 100,
      atrasoRelativo: null,
    },
    sabor,
    score: 1,
    confianca: 0.5,
    dimensoesUsadas: [],
    porque: [],
    rankFinal: 1,
    nome: null,
    telefone: null,
    clienteUserId: null,
  };
}

describe('chaveDiaExibidaCaca', () => {
  it('compõe a chave com o dia', () => {
    expect(chaveDiaExibidaCaca('2026-06-05')).toBe('caca_exibida_2026-06-05');
  });
});

describe('resumoSabores', () => {
  it('conta candidatos por sabor', () => {
    const r = resumoSabores([
      display('cross_empresa'),
      display('cross_empresa'),
      display('dormente'),
      display('frio'),
      display('frio'),
      display('frio'),
    ]);
    expect(r).toEqual({ cross_empresa: 2, dormente: 1, frio: 3 });
  });

  it('lista vazia → objeto vazio', () => {
    expect(resumoSabores([])).toEqual({});
  });

  it('sabores ausentes não aparecem no resumo (não força zero)', () => {
    const r = resumoSabores([display('cross_empresa')]);
    expect(r).toEqual({ cross_empresa: 1 });
    expect(r.dormente).toBeUndefined();
    expect(r.frio).toBeUndefined();
  });
});
