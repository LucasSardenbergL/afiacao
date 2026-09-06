import { describe, it, expect } from 'vitest';
import {
  FATOR_MAX,
  FatorAprovadoDivergenteError,
  FatorConversaoInvalidoError,
  MapeamentoAmbiguoError,
  QtdeNaoMultiploEmbalagemError,
  indexarMapeamentos,
  qtdeFisicaOmie,
  qtdePortal,
  qtdePortalCanonica,
  quantidadeCompraCanonica,
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
  it('NULL/undefined = aprovado SEM embalagem (1:1): vivo 1 passa', () => {
    expect(() => verificarFatorAprovado(null, 1, 'X')).not.toThrow();
    expect(() => verificarFatorAprovado(undefined, 1, 'X')).not.toThrow();
  });
  it('TOCTOU residual (Codex P0 #2166): NULL aprovado e vivo 0,2 → recusa com a marca fator_aprovado_ausente', () => {
    // O comprador aprovou 36 L com fator 1 (motor não arredondou → NULL). Alguém cadastra 0,2 antes do envio:
    // antes a edge aceitava, comprava 8 BB e normalizava 36 → 40 L sem reaprovação. Agora: recusa.
    let erro: unknown;
    try {
      verificarFatorAprovado(null, 0.2, 'TEH.3505.00BB');
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(FatorAprovadoDivergenteError);
    const d = erro as FatorAprovadoDivergenteError;
    expect(d.motivo).toBe('fator_aprovado_ausente');
    expect(d.fatorAprovado).toBeNull();
    expect(d.fatorVivo).toBe(0.2);
    expect(d.message).toContain('TEH.3505.00BB');
    expect(d.message).toMatch(/reaprov/i);
    expect(() => verificarFatorAprovado(undefined, 0.18, 'X')).toThrow(FatorAprovadoDivergenteError);
  });
  it('a marca do ramo distingue AUSENTE de DIVERGENTE (o sensor conta por motivo)', () => {
    let erro: unknown;
    try {
      verificarFatorAprovado(0.2, 0.18, 'X');
    } catch (e) {
      erro = e;
    }
    expect((erro as FatorAprovadoDivergenteError).motivo).toBe('fator_aprovado_divergente');
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

describe('qtdePortalCanonica: enviado = aprovado — a quantidade aprovada TEM de ser a compra física', () => {
  it('múltiplo exato da embalagem: devolve a qtde do portal (é o produto que a edge USA)', () => {
    expect(qtdePortalCanonica(40, 0.2, 'X')).toBe(8);
    expect(qtdePortalCanonica(5, 0.2, 'X')).toBe(1);
    expect(qtdePortalCanonica(37, 1, 'X')).toBe(37);
    expect(qtdePortalCanonica(10.8, 1 / 3.6, 'X')).toBe(3); // round6 continua fazendo trabalho
  });
  it('Codex P0 #2166: 37 L editado à mão com fator 0,2 → recusa (antes virava 40 e ia sem reaprovação)', () => {
    let erro: unknown;
    try {
      qtdePortalCanonica(37, 0.2, 'TEH.3505.00BB');
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(QtdeNaoMultiploEmbalagemError);
    const d = erro as QtdeNaoMultiploEmbalagemError;
    expect(d.sku).toBe('TEH.3505.00BB');
    expect(d.qtdeFinal).toBe(37);
    expect(d.qtdePortal).toBe(8);
    expect(d.qtdeFisica).toBe(40);
    expect(d.fator).toBe(0.2);
    expect(d.message).toContain('37');
    expect(d.message).toContain('40');
    expect(d.message).toMatch(/reaprov/i);
  });
  it('tabela: 36 L (motor velho) · 0 · fração com fator 1 · poeira legada → todos recusam; múltiplos passam', () => {
    for (const [q, f] of [[36, 0.2], [0, 0.2], [0, 1], [36.5, 1], [3.99996, 1], [41, 0.2], [-5, 1]] as const) {
      expect(() => qtdePortalCanonica(q, f, 'X'), `${q} × ${f}`).toThrow(QtdeNaoMultiploEmbalagemError);
    }
    for (const [q, f, p] of [[40, 0.2, 8], [1000, 0.2, 200], [1, 1, 1], [21.6, 1 / 3.6, 6]] as const) {
      expect(qtdePortalCanonica(q, f, 'X'), `${q} × ${f}`).toBe(p);
    }
  });
  it('fator inválido continua lançando a marca do FATOR (não a da quantidade)', () => {
    expect(() => qtdePortalCanonica(40, 0, 'X')).toThrow(FatorConversaoInvalidoError);
    expect(() => qtdePortalCanonica(40, 1e9, 'X')).toThrow(FatorConversaoInvalidoError);
    expect(() => qtdePortalCanonica(Number.NaN, 0.2, 'X')).toThrow(FatorConversaoInvalidoError);
  });
});

describe('quantidadeCompraCanonica (UI): a edição humana já grava no múltiplo que a edge aceita', () => {
  it('sem fator (null/undefined/0) = ceil inteiro (status quo do [QTDE-INTEIRA])', () => {
    expect(quantidadeCompraCanonica(36.2, null)).toBe(37);
    expect(quantidadeCompraCanonica(37, undefined)).toBe(37);
    expect(quantidadeCompraCanonica(37, 0)).toBe(37);
    expect(quantidadeCompraCanonica(Number.NaN, null)).toBe(0);
  });
  it('com fator 0,2: sobe ao próximo balde (37 → 40, 41 → 45, 40 → 40); 0 fica 0 (campo limpo)', () => {
    expect(quantidadeCompraCanonica(37, 0.2)).toBe(40);
    expect(quantidadeCompraCanonica(41, 0.2)).toBe(45);
    expect(quantidadeCompraCanonica(40, 0.2)).toBe(40);
    expect(quantidadeCompraCanonica(0, 0.2)).toBe(0);
    expect(quantidadeCompraCanonica('40' as unknown as number, '0.2' as unknown as number)).toBe(40);
  });
  it('o que a UI grava passa na edge (round-trip com a MESMA regra)', () => {
    for (const q of [1, 7, 36, 37, 41, 99, 1234]) {
      const c = quantidadeCompraCanonica(q, 0.2);
      expect(() => qtdePortalCanonica(c, 0.2, 'X')).not.toThrow();
    }
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
