import { describe, it, expect } from 'vitest';
import { labelSabor, faixaConfianca, classeSabor, agruparPorDocumento } from '../apresentacao';
import type { SaborCaca, CacaCandidatoDisplay } from '../types';

// ─── labelSabor ────────────────────────────────────────────────────────────────

describe('labelSabor', () => {
  it('cross_empresa → rótulo claro de cross-venda', () => {
    expect(labelSabor('cross_empresa')).toBe('Compra em outra empresa do grupo');
  });

  it('dormente → rótulo de reativação', () => {
    expect(labelSabor('dormente')).toBe('Parou de comprar');
  });

  it('frio → rótulo de prospecção fria', () => {
    expect(labelSabor('frio')).toBe('Nunca comprou');
  });

  it('todos os sabores retornam string não-vazia', () => {
    const sabores: SaborCaca[] = ['cross_empresa', 'dormente', 'frio'];
    for (const s of sabores) {
      expect(labelSabor(s).length).toBeGreaterThan(0);
    }
  });

  it('cada sabor retorna rótulo distinto', () => {
    const cross = labelSabor('cross_empresa');
    const dorm = labelSabor('dormente');
    const frio = labelSabor('frio');
    expect(cross).not.toBe(dorm);
    expect(cross).not.toBe(frio);
    expect(dorm).not.toBe(frio);
  });
});

// ─── faixaConfianca ────────────────────────────────────────────────────────────

describe('faixaConfianca', () => {
  it('0.75 → alta (limite inferior da faixa alta)', () => {
    expect(faixaConfianca(0.75)).toBe('alta');
  });

  it('1.0 → alta', () => {
    expect(faixaConfianca(1.0)).toBe('alta');
  });

  it('0.9 → alta', () => {
    expect(faixaConfianca(0.9)).toBe('alta');
  });

  it('0.74 → media (logo abaixo do limiar de alta)', () => {
    expect(faixaConfianca(0.74)).toBe('media');
  });

  it('0.40 → media (limite inferior da faixa média)', () => {
    expect(faixaConfianca(0.40)).toBe('media');
  });

  it('0.5 → media', () => {
    expect(faixaConfianca(0.5)).toBe('media');
  });

  it('0.39 → baixa (logo abaixo do limiar de média)', () => {
    expect(faixaConfianca(0.39)).toBe('baixa');
  });

  it('0.0 → baixa', () => {
    expect(faixaConfianca(0.0)).toBe('baixa');
  });

  it('0.1 → baixa', () => {
    expect(faixaConfianca(0.1)).toBe('baixa');
  });

  it('retorna "alta" | "media" | "baixa" para qualquer valor entre 0 e 1', () => {
    const valores = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const validas = new Set<string>(['alta', 'media', 'baixa']);
    for (const v of valores) {
      expect(validas.has(faixaConfianca(v))).toBe(true);
    }
  });
});

// ─── classeSabor ───────────────────────────────────────────────────────────────

describe('classeSabor', () => {
  it('cross_empresa → text-status-info', () => {
    expect(classeSabor('cross_empresa')).toBe('text-status-info');
  });

  it('dormente → text-status-warning', () => {
    expect(classeSabor('dormente')).toBe('text-status-warning');
  });

  it('frio → text-muted-foreground', () => {
    expect(classeSabor('frio')).toBe('text-muted-foreground');
  });

  it('cada sabor tem classe CSS distinta', () => {
    const cross = classeSabor('cross_empresa');
    const dorm = classeSabor('dormente');
    const frio = classeSabor('frio');
    expect(cross).not.toBe(dorm);
    expect(cross).not.toBe(frio);
    expect(dorm).not.toBe(frio);
  });

  it('todas as classes são strings não-vazias', () => {
    const sabores: SaborCaca[] = ['cross_empresa', 'dormente', 'frio'];
    for (const s of sabores) {
      expect(classeSabor(s).length).toBeGreaterThan(0);
    }
  });
});

// ─── agruparPorDocumento ───────────────────────────────────────────────────────

/** Helper para criar um CacaCandidatoDisplay mínimo para testes. */
function makeDisplay(
  overrides: {
    documento: string;
    empresaAlvo?: string;
    rankFinal?: number;
    sabor?: SaborCaca;
    confianca?: number;
    nome?: string | null;
    telefone?: string | null;
    clienteUserId?: string | null;
  },
): CacaCandidatoDisplay {
  return {
    features: {
      documento: overrides.documento,
      empresaAlvo: (overrides.empresaAlvo ?? 'oben') as CacaCandidatoDisplay['features']['empresaAlvo'],
      cidadeUf: null,
      ramo: null,
      ticketFaixa: null,
      familias: [],
      compraEmOutraEmpresa: overrides.sabor === 'cross_empresa',
      compraNaEmpresaAlvo: false,
      ultimaCompraGrupoDias: overrides.sabor === 'frio' ? null : 60,
      atrasoRelativo: null,
    },
    sabor: overrides.sabor ?? 'frio',
    score: 0.5,
    confianca: overrides.confianca ?? 0.5,
    dimensoesUsadas: [],
    porque: [],
    rankFinal: overrides.rankFinal ?? 1,
    nome: overrides.nome ?? null,
    telefone: overrides.telefone ?? null,
    clienteUserId: overrides.clienteUserId ?? null,
  };
}

describe('agruparPorDocumento', () => {
  it('lista vazia → array vazio', () => {
    expect(agruparPorDocumento([])).toHaveLength(0);
  });

  it('documento único com 1 empresa-alvo → 1 card com 1 empresa', () => {
    const candidatos = [makeDisplay({ documento: '11222333000144', empresaAlvo: 'oben', rankFinal: 1 })];
    const grupos = agruparPorDocumento(candidatos);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].documento).toBe('11222333000144');
    expect(grupos[0].empresasAlvo).toEqual(['oben']);
  });

  it('mesmo documento com 2 empresas-alvo → 1 card com 2 empresas', () => {
    const candidatos = [
      makeDisplay({ documento: '11222333000144', empresaAlvo: 'oben', rankFinal: 1, sabor: 'cross_empresa' }),
      makeDisplay({ documento: '11222333000144', empresaAlvo: 'colacor', rankFinal: 3, sabor: 'dormente' }),
    ];
    const grupos = agruparPorDocumento(candidatos);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].empresasAlvo).toContain('oben');
    expect(grupos[0].empresasAlvo).toContain('colacor');
  });

  it('documentos distintos → cards separados', () => {
    const candidatos = [
      makeDisplay({ documento: 'doc1', empresaAlvo: 'oben', rankFinal: 1 }),
      makeDisplay({ documento: 'doc2', empresaAlvo: 'oben', rankFinal: 2 }),
    ];
    const grupos = agruparPorDocumento(candidatos);
    expect(grupos).toHaveLength(2);
  });

  it('representante do grupo é o de menor rankFinal', () => {
    const candidatos = [
      makeDisplay({ documento: '11222333000144', empresaAlvo: 'colacor', rankFinal: 5, nome: 'Pior rank' }),
      makeDisplay({ documento: '11222333000144', empresaAlvo: 'oben', rankFinal: 1, nome: 'Melhor rank' }),
    ];
    const grupos = agruparPorDocumento(candidatos);
    expect(grupos[0].display.nome).toBe('Melhor rank');
    expect(grupos[0].display.rankFinal).toBe(1);
  });

  it('ordenação preserva o rank do representante de cada grupo', () => {
    const candidatos = [
      makeDisplay({ documento: 'doc3', empresaAlvo: 'oben', rankFinal: 3 }),
      makeDisplay({ documento: 'doc1', empresaAlvo: 'oben', rankFinal: 1 }),
      makeDisplay({ documento: 'doc2', empresaAlvo: 'oben', rankFinal: 2 }),
    ];
    const grupos = agruparPorDocumento(candidatos);
    expect(grupos[0].documento).toBe('doc1');
    expect(grupos[1].documento).toBe('doc2');
    expect(grupos[2].documento).toBe('doc3');
  });

  it('candidato frio sem nome e sem telefone (não-vinculado) → agrupado corretamente', () => {
    const candidatos = [
      makeDisplay({
        documento: '99888777000166',
        empresaAlvo: 'oben',
        rankFinal: 1,
        sabor: 'frio',
        nome: null,
        telefone: null,
        clienteUserId: null,
      }),
    ];
    const grupos = agruparPorDocumento(candidatos);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].display.nome).toBeNull();
    expect(grupos[0].display.telefone).toBeNull();
    expect(grupos[0].display.clienteUserId).toBeNull();
  });

  it('um documento com 3 empresas-alvo → 1 card com as 3 empresas', () => {
    const candidatos = [
      makeDisplay({ documento: 'multi', empresaAlvo: 'oben', rankFinal: 1 }),
      makeDisplay({ documento: 'multi', empresaAlvo: 'colacor', rankFinal: 2 }),
      makeDisplay({ documento: 'multi', empresaAlvo: 'colacor_sc', rankFinal: 3 }),
    ];
    const grupos = agruparPorDocumento(candidatos);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].empresasAlvo).toHaveLength(3);
    expect(grupos[0].empresasAlvo).toContain('oben');
    expect(grupos[0].empresasAlvo).toContain('colacor');
    expect(grupos[0].empresasAlvo).toContain('colacor_sc');
  });

  it('cross_empresa agrupado com dormente → mantém o de menor rankFinal', () => {
    const cross = makeDisplay({
      documento: 'abc',
      empresaAlvo: 'oben',
      rankFinal: 2,
      sabor: 'cross_empresa',
      nome: 'Empresa Cross',
    });
    const dorm = makeDisplay({
      documento: 'abc',
      empresaAlvo: 'colacor',
      rankFinal: 5,
      sabor: 'dormente',
      nome: 'Empresa Dorm',
    });
    const grupos = agruparPorDocumento([cross, dorm]);
    expect(grupos[0].display.sabor).toBe('cross_empresa');
    expect(grupos[0].display.nome).toBe('Empresa Cross');
  });
});
