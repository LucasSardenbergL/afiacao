import { describe, it, expect } from 'vitest';
import {
  FATOR_MAX,
  FatorAprovadoDivergenteError,
  FatorConversaoInvalidoError,
  MapeamentoAmbiguoError,
  indexarMapeamentos,
  qtdeFisicaOmie,
  qtdePortal,
  verificarFatorAprovado,
} from '@/lib/reposicao/qtde-portal';

// Fonte da verdade do helper espelhado na edge `enviar-pedido-portal-sayerlack/qtde-portal.ts`
// (paridade textual em `qtde-portal-edge-invariants.test.ts`). Os casos do `qtdePortal`/`qtdeFisicaOmie`
// já vivem no Deno test da edge; aqui entram os 3 achados do challenge Codex de 2026-09-05.

describe('qtdePortal/qtdeFisicaOmie: bound de finitude espelha o SQL (fator_conversao < 1e9)', () => {
  it('1e9 é recusado nos dois sentidos — o CHECK fator_positivo do banco recusa o mesmo valor', () => {
    expect(FATOR_MAX).toBe(1e9);
    expect(() => qtdePortal(36, 1e9)).toThrow(FatorConversaoInvalidoError);
    expect(() => qtdePortal(36, 1e12)).toThrow(FatorConversaoInvalidoError);
    expect(() => qtdeFisicaOmie(8, 1e9)).toThrow(FatorConversaoInvalidoError);
  });
  it('logo abaixo do bound segue aceito (o bound é de finitude, não de plausibilidade)', () => {
    expect(qtdePortal(1, 1e9 - 1)).toBe(1e9 - 1);
    expect(qtdePortal(36, 0.2)).toBe(8);
  });
});

describe('verificarFatorAprovado: o comprador aprovou N embalagens com o fator DA APROVAÇÃO', () => {
  it('NULL/undefined = o motor não arredondou → nada a conferir', () => {
    expect(() => verificarFatorAprovado(null, 0.2, 'X')).not.toThrow();
    expect(() => verificarFatorAprovado(undefined, 0.18, 'X')).not.toThrow();
  });
  it('fator igual (inclusive vindo como string numeric do PostgREST) passa', () => {
    expect(() => verificarFatorAprovado(0.2, 0.2, 'X')).not.toThrow();
    expect(() => verificarFatorAprovado('0.2', 0.2, 'X')).not.toThrow();
    expect(() => verificarFatorAprovado('0.20000000', 0.2, 'X')).not.toThrow();
  });
  it('TOCTOU: fator mudou entre aprovação e envio (0,2 → 0,18) → recusa com a marca do ramo', () => {
    let erro: unknown;
    try {
      verificarFatorAprovado(0.2, 0.18, 'TEH.3505.00BB');
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(FatorAprovadoDivergenteError);
    const d = erro as FatorAprovadoDivergenteError;
    expect(d.sku).toBe('TEH.3505.00BB');
    expect(d.fatorAprovado).toBe(0.2);
    expect(d.fatorVivo).toBe(0.18);
    // motivo VISÍVEL ao comprador: os dois fatores e o que fazer
    expect(d.message).toContain('TEH.3505.00BB');
    expect(d.message).toContain('0.2');
    expect(d.message).toContain('0.18');
    expect(d.message).toMatch(/reaprov/i);
  });
  it('fator aprovado inválido (0, NaN, 1e9, lixo) NUNCA casa com um vivo válido', () => {
    for (const ruim of [0, -0.2, Number.NaN, 1e9, 'abc', '']) {
      expect(() => verificarFatorAprovado(ruim as number | string, 0.2, 'X')).toThrow(FatorAprovadoDivergenteError);
    }
  });
  it('igualdade EXATA: Δ de 9e-10 já troca 200 por 201 embalagens em 1.000 L → diverge (sem epsilon)', () => {
    expect(() => verificarFatorAprovado(0.2, 0.2000000009, 'X')).toThrow(FatorAprovadoDivergenteError);
    expect(() => verificarFatorAprovado(1 / 3.6, 0.277777778, 'X')).toThrow(FatorAprovadoDivergenteError);
    // e o que o banco devolve para o MESMO numeric casa sempre (mesma string → mesmo Number)
    expect(() => verificarFatorAprovado('0.2777777777777778', 0.2777777777777778, 'X')).not.toThrow();
  });
});

describe('indexarMapeamentos: 1 linha ativa por sku_omie, senão ambiguidade fail-closed', () => {
  type Row = { sku_omie: string; ativo: boolean | null; fator_conversao: number };
  it('indexa por sku_omie', () => {
    const m = indexarMapeamentos<Row>([
      { sku_omie: 'A', ativo: true, fator_conversao: 1 },
      { sku_omie: 'B', ativo: true, fator_conversao: 0.2 },
    ]);
    expect(m.get('A')?.fator_conversao).toBe(1);
    expect(m.get('B')?.fator_conversao).toBe(0.2);
    expect(m.size).toBe(2);
  });
  it('>1 linha ATIVA para o mesmo sku_omie → MapeamentoAmbiguoError com o sku e a contagem (nunca last-wins)', () => {
    let erro: unknown;
    try {
      indexarMapeamentos<Row>([
        { sku_omie: 'A', ativo: true, fator_conversao: 1 },
        { sku_omie: 'A', ativo: true, fator_conversao: 0.2 },
      ]);
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(MapeamentoAmbiguoError);
    expect((erro as MapeamentoAmbiguoError).sku).toBe('A');
    expect((erro as MapeamentoAmbiguoError).n).toBe(2);
  });
  it('ativa + inativa para o mesmo sku → a ATIVA vence, independentemente da ordem', () => {
    const ativa: Row = { sku_omie: 'A', ativo: true, fator_conversao: 0.2 };
    const inativa: Row = { sku_omie: 'A', ativo: false, fator_conversao: 1 };
    expect(indexarMapeamentos([inativa, ativa]).get('A')).toBe(ativa);
    expect(indexarMapeamentos([ativa, inativa]).get('A')).toBe(ativa);
  });
  it('só inativas → fica uma inativa (o chamador recusa por "sem mapeamento ativo", com o motivo certo)', () => {
    const m = indexarMapeamentos<Row>([
      { sku_omie: 'A', ativo: false, fator_conversao: 1 },
      { sku_omie: 'A', ativo: null, fator_conversao: 1 },
    ]);
    expect(m.get('A')?.ativo === true).toBe(false);
    expect(m.size).toBe(1);
  });
});
