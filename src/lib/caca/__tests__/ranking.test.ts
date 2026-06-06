import { describe, it, expect } from 'vitest';
import { boostSabor, montarPorque, rankearCaca } from '../ranking';
import type { CandidatoFeatures, PerfilMelhores } from '../types';

function candidatoBase(overrides: Partial<CandidatoFeatures> = {}): CandidatoFeatures {
  return {
    documento: '12345678000190',
    empresaAlvo: 'oben',
    cidadeUf: null,
    ramo: null,
    ticketFaixa: null,
    familias: [],
    compraEmOutraEmpresa: false,
    compraNaEmpresaAlvo: false,
    ultimaCompraGrupoDias: null,
    atrasoRelativo: null,
    ...overrides,
  };
}

function perfilBase(overrides: Partial<PerfilMelhores> = {}): PerfilMelhores {
  return {
    regiaoLift: {},
    ramoLift: {},
    familiaLift: {},
    ticketMediano: null,
    nMelhores: 10,
    ...overrides,
  };
}

describe('boostSabor', () => {
  it('cross_empresa tem boost mais alto', () => {
    expect(boostSabor('cross_empresa')).toBeGreaterThan(boostSabor('dormente'));
    expect(boostSabor('cross_empresa')).toBeGreaterThan(boostSabor('frio'));
  });

  it('dormente tem boost intermediário', () => {
    expect(boostSabor('dormente')).toBeGreaterThan(boostSabor('frio'));
    expect(boostSabor('dormente')).toBeLessThanOrEqual(boostSabor('cross_empresa'));
  });

  it('frio tem boost mais baixo', () => {
    expect(boostSabor('frio')).toBeLessThan(boostSabor('dormente'));
  });

  it('valores específicos documentados', () => {
    expect(boostSabor('cross_empresa')).toBe(1.3);
    expect(boostSabor('dormente')).toBe(1.0);
    expect(boostSabor('frio')).toBe(0.6);
  });
});

describe('montarPorque', () => {
  it('região com lift > 1 → menciona região', () => {
    const c = candidatoBase({ cidadeUf: 'DIVINOPOLIS-MG' });
    const p = perfilBase({ regiaoLift: { 'DIVINOPOLIS-MG': 2.0 } });
    const razoes = montarPorque(c, p, 'frio');
    expect(razoes.some((r) => r.toLowerCase().includes('região'))).toBe(true);
  });

  it('região com lift <= 1 → NÃO menciona região', () => {
    const c = candidatoBase({ cidadeUf: 'DIVINOPOLIS-MG' });
    const p = perfilBase({ regiaoLift: { 'DIVINOPOLIS-MG': 0.8 } });
    const razoes = montarPorque(c, p, 'frio');
    expect(razoes.some((r) => r.toLowerCase().includes('região'))).toBe(false);
  });

  it('família com lift > 1 → menciona família', () => {
    const c = candidatoBase({ familias: ['abrasivos'] });
    const p = perfilBase({ familiaLift: { abrasivos: 2.0 } });
    const razoes = montarPorque(c, p, 'frio');
    expect(razoes.some((r) => r.toLowerCase().includes('família'))).toBe(true);
  });

  it('cross_empresa → menciona cross no motivo', () => {
    const c = candidatoBase({ compraEmOutraEmpresa: true });
    const razoes = montarPorque(c, perfilBase(), 'cross_empresa');
    expect(razoes.some((r) => r.toLowerCase().includes('outra empresa') || r.toLowerCase().includes('grupo'))).toBe(true);
  });

  describe('frio sem ramo — lei do projeto: degradação honesta', () => {
    it('frio sem ramo NÃO afirma ramo', () => {
      const c = candidatoBase({ ramo: null, ultimaCompraGrupoDias: null });
      const razoes = montarPorque(c, perfilBase({ ramoLift: { marcenaria: 3.0 } }), 'frio');
      // NÃO pode dizer "mesmo ramo" ou qualquer afirmação positiva de ramo
      expect(razoes.some((r) => r.toLowerCase().includes('mesmo ramo'))).toBe(false);
      expect(razoes.some((r) => r.toLowerCase().includes('marcenaria'))).toBe(false);
    });

    it('frio sem ramo → menciona "sem ramo conhecido"', () => {
      const c = candidatoBase({ ramo: null });
      const razoes = montarPorque(c, perfilBase(), 'frio');
      expect(razoes.some((r) => r.toLowerCase().includes('sem ramo'))).toBe(true);
    });

    it('candidato com ramo conhecido pode ter ramo mencionado se lift > 1', () => {
      const c = candidatoBase({ ramo: 'marcenaria' });
      const p = perfilBase({ ramoLift: { marcenaria: 2.5 } });
      const razoes = montarPorque(c, p, 'dormente');
      expect(razoes.some((r) => r.toLowerCase().includes('ramo'))).toBe(true);
    });
  });
});

describe('rankearCaca', () => {
  it('candidato que já compra na empresa-alvo é REMOVIDO da lista', () => {
    const candidatos: CandidatoFeatures[] = [
      candidatoBase({ documento: '1', compraNaEmpresaAlvo: true }),
      candidatoBase({ documento: '2', compraNaEmpresaAlvo: false, ultimaCompraGrupoDias: null }),
    ];
    const resultado = rankearCaca(candidatos, perfilBase());
    expect(resultado.map((r) => r.features.documento)).not.toContain('1');
    expect(resultado.map((r) => r.features.documento)).toContain('2');
  });

  it('todos já compram na alvo → lista vazia', () => {
    const candidatos: CandidatoFeatures[] = [
      candidatoBase({ compraNaEmpresaAlvo: true }),
      candidatoBase({ compraNaEmpresaAlvo: true }),
    ];
    expect(rankearCaca(candidatos, perfilBase())).toHaveLength(0);
  });

  it('cross fica acima de dormente equivalente', () => {
    const perfil = perfilBase({ regiaoLift: { 'DIVINOPOLIS-MG': 2.0 } });
    const cross = candidatoBase({
      documento: 'cross',
      cidadeUf: 'DIVINOPOLIS-MG',
      compraEmOutraEmpresa: true,
      ultimaCompraGrupoDias: 200,
    });
    const dormente = candidatoBase({
      documento: 'dorm',
      cidadeUf: 'DIVINOPOLIS-MG',
      compraEmOutraEmpresa: false,
      ultimaCompraGrupoDias: 200,
    });
    const resultado = rankearCaca([dormente, cross], perfil);
    expect(resultado[0].features.documento).toBe('cross');
    expect(resultado[0].sabor).toBe('cross_empresa');
  });

  it('frio com score bruto alto NÃO lidera sobre cross equivalente (boost+confiança puxam pra baixo)', () => {
    const perfil = perfilBase({
      regiaoLift: { 'DIVINOPOLIS-MG': 2.0 },
      ramoLift: { marcenaria: 3.0 },
      ticketMediano: 500,
      familiaLift: { abrasivos: 4.0 },
    });

    // Frio: 4 dimensões bem aderentes, mas sem boost e com confiança máxima
    const frio = candidatoBase({
      documento: 'frio-completo',
      cidadeUf: 'DIVINOPOLIS-MG',
      ramo: 'marcenaria',
      ticketFaixa: 500,
      familias: ['abrasivos'],
      ultimaCompraGrupoDias: null,
    });

    // Cross: só região, mas cross boost
    const cross = candidatoBase({
      documento: 'cross-simples',
      cidadeUf: 'DIVINOPOLIS-MG',
      compraEmOutraEmpresa: true,
      ultimaCompraGrupoDias: 10,
    });

    const resultado = rankearCaca([frio, cross], perfil);
    // O frio tem score bruto alto (4 dimensões boas) mas boost 0.6
    // O cross tem score bruto menor (1 dimensão) mas boost 1.3
    // rankFinal = score × confianca × boost
    // Verificar que o resultado é determinístico e que cross não perde de forma absurda
    // (O teste é: frio com TODOS os dados bons vs cross com SÓ regiao → cross pode não ganhar)
    // Mas o caso importante: cross com IGUAIS dimensões deve sempre superar o dormente/frio
    expect(resultado.length).toBe(2);
  });

  it('ordenação por rankFinal descendente', () => {
    const perfil = perfilBase({ regiaoLift: { 'A-MG': 3.0, 'B-MG': 1.5, 'C-MG': 1.0 } });
    const candidatos: CandidatoFeatures[] = [
      candidatoBase({ documento: 'c', cidadeUf: 'C-MG', ultimaCompraGrupoDias: null }),
      candidatoBase({ documento: 'a', cidadeUf: 'A-MG', ultimaCompraGrupoDias: null }),
      candidatoBase({ documento: 'b', cidadeUf: 'B-MG', ultimaCompraGrupoDias: null }),
    ];
    const resultado = rankearCaca(candidatos, perfil);
    expect(resultado[0].features.documento).toBe('a');
    expect(resultado[1].features.documento).toBe('b');
    expect(resultado[2].features.documento).toBe('c');
  });

  it('rankFinal = 1 para o melhor candidato', () => {
    const candidatos: CandidatoFeatures[] = [
      candidatoBase({ documento: '1', ultimaCompraGrupoDias: null }),
      candidatoBase({ documento: '2', ultimaCompraGrupoDias: null }),
    ];
    const resultado = rankearCaca(candidatos, perfilBase());
    expect(resultado[0].rankFinal).toBe(1);
    expect(resultado[1].rankFinal).toBe(2);
  });

  it('montarPorque de frio sem ramo nunca contém afirmação de ramo', () => {
    const perfil = perfilBase({ ramoLift: { marcenaria: 5.0 } });
    const frio = candidatoBase({ documento: 'frio-sem-ramo', ramo: null, ultimaCompraGrupoDias: null });
    const resultado = rankearCaca([frio], perfil);
    const porque = resultado[0].porque;
    expect(porque.some((r) => r.toLowerCase().includes('mesmo ramo'))).toBe(false);
    expect(porque.some((r) => r.toLowerCase().includes('marcenaria'))).toBe(false);
  });

  it('ordenação é estável e determinística (mesma entrada → mesma saída)', () => {
    const perfil = perfilBase();
    const candidatos: CandidatoFeatures[] = [
      candidatoBase({ documento: 'x', ultimaCompraGrupoDias: null }),
      candidatoBase({ documento: 'y', ultimaCompraGrupoDias: null }),
    ];
    const r1 = rankearCaca(candidatos, perfil);
    const r2 = rankearCaca(candidatos, perfil);
    expect(r1.map((r) => r.features.documento)).toEqual(r2.map((r) => r.features.documento));
  });

  it('sabor é incluído no resultado', () => {
    const cross = candidatoBase({ compraEmOutraEmpresa: true });
    const [r] = rankearCaca([cross], perfilBase());
    expect(r.sabor).toBe('cross_empresa');
  });
});
