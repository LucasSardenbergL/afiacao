import { describe, it, expect } from 'vitest';
import { parsePrazoRecebimento, custoCapitalPrazo, pisoComPrazo } from '../prazo-helpers';
import { avaliarReguaPreco } from '../regua-preco-helpers';
import type { ReguaPrecoInput } from '../types';

// F2 — custo do prazo no piso. Formatos reais puxados da prod (psql-ro) + gates do Codex (xhigh).

describe('parsePrazoRecebimento — formatos reais da descricao', () => {
  it('lista por barras (dias desde a emissão)', () => {
    expect(parsePrazoRecebimento('30/60/90', 3)).toEqual([30, 60, 90]);
    expect(parsePrazoRecebimento('28/56/84', 3)).toEqual([28, 56, 84]);
    expect(parsePrazoRecebimento('30/45/60/75', 4)).toEqual([30, 45, 60, 75]);
    expect(parsePrazoRecebimento('21/51', 2)).toEqual([21, 51]);
  });
  it('token à vista → 0 (entra no n)', () => {
    expect(parsePrazoRecebimento('A Vista/30/60', 3)).toEqual([0, 30, 60]);
    expect(parsePrazoRecebimento('A Vista/30/60/90/120', 5)).toEqual([0, 30, 60, 90, 120]);
    expect(parsePrazoRecebimento('À Vista/21', 2)).toEqual([0, 21]);
  });
  it('prazo único "Para N dias"', () => {
    expect(parsePrazoRecebimento('Para 30 dias', 1)).toEqual([30]);
    expect(parsePrazoRecebimento('Para 75 dias', 1)).toEqual([75]);
    expect(parsePrazoRecebimento('Para 5 dias', 1)).toEqual([5]);
  });
});

describe('parsePrazoRecebimento — degrada (null) sem adivinhar', () => {
  it('tokens ≠ numParcelas', () => {
    expect(parsePrazoRecebimento('30/60/90', 2)).toBeNull();
    expect(parsePrazoRecebimento('Para 30 dias', 3)).toBeNull();
  });
  it('token não reconhecido', () => {
    expect(parsePrazoRecebimento('30/xx/90', 3)).toBeNull();
    expect(parsePrazoRecebimento('boleto', 1)).toBeNull();
    expect(parsePrazoRecebimento('30/60/', 3)).toBeNull(); // token vazio
  });
  it('dia > 180 degrada (Codex P1: "Para 999 dias" NÃO pode virar piso +78%)', () => {
    expect(parsePrazoRecebimento('Para 999 dias', 1)).toBeNull();
    expect(parsePrazoRecebimento('30/60/200', 3)).toBeNull();
  });
  it('lista não-monotônica (texto suspeito)', () => {
    expect(parsePrazoRecebimento('60/30/90', 3)).toBeNull();
  });
  it('numParcelas fora de [1..12] (outliers 36/999 do catálogo)', () => {
    expect(parsePrazoRecebimento('30', 0)).toBeNull();
    expect(parsePrazoRecebimento('30', 36)).toBeNull();
    expect(parsePrazoRecebimento('30', 999)).toBeNull();
  });
  it('entradas nulas', () => {
    expect(parsePrazoRecebimento(null, 3)).toBeNull();
    expect(parsePrazoRecebimento('30/60/90', null)).toBeNull();
    expect(parsePrazoRecebimento('', 1)).toBeNull();
  });
});

describe('custoCapitalPrazo — (selic+spread)/100, exclui armazenagem, unit gate', () => {
  it('valores reais da OBEN → 0,1775 (17,75% a.a.)', () => {
    expect(custoCapitalPrazo(14.75, 3.0)).toBeCloseTo(0.1775, 6);
  });
  it('exclui armazenagem: NÃO recebe o 3º componente (assinatura só tem 2 args)', () => {
    // Garantia estrutural: a função não soma armazenagem_fisica (8,00) — daria 0,2575.
    expect(custoCapitalPrazo(14.75, 3.0)).not.toBeCloseTo(0.2575, 4);
  });
  it('componente fora de [0,100] → null', () => {
    expect(custoCapitalPrazo(-1, 3)).toBeNull();
    expect(custoCapitalPrazo(14.75, 200)).toBeNull();
  });
  it('taxa final ≥ 100% a.a. (erro de unidade) → null', () => {
    expect(custoCapitalPrazo(60, 50)).toBeNull(); // 110% → null
  });
  it('entradas nulas / não-finitas → null', () => {
    expect(custoCapitalPrazo(null, 3)).toBeNull();
    expect(custoCapitalPrazo(14.75, undefined)).toBeNull();
    expect(custoCapitalPrazo(NaN, 3)).toBeNull();
  });
});

describe('pisoComPrazo — Candidato A: piso = cmc/(S − aliquota)', () => {
  const r = 0.1775;
  const a = 0.18;
  const cmc = 100;

  it('90 dias (1 parcela) → 128,12 (número validado pelo Codex)', () => {
    const res = pisoComPrazo(cmc, a, [90], r)!;
    expect(res.piso).toBeCloseTo(128.12, 1);
  });
  it('0/30/60/90 (4 parcelas iguais) → 124,97', () => {
    const res = pisoComPrazo(cmc, a, [0, 30, 60, 90], r)!;
    expect(res.piso).toBeCloseTo(124.97, 1);
  });
  it('30/60/90 → 126,01', () => {
    const res = pisoComPrazo(cmc, a, [30, 60, 90], r)!;
    expect(res.piso).toBeCloseTo(126.01, 1);
  });
  it('à vista pura [0] degenera para o piso à vista (custoRs ≈ 0)', () => {
    const res = pisoComPrazo(cmc, a, [0], r)!;
    expect(res.piso).toBeCloseTo(cmc / (1 - a), 6); // 121,951
    expect(res.custoRs).toBeCloseTo(0, 9);
    expect(res.S).toBeCloseTo(1, 9);
  });
  it('piso do prazo é SEMPRE ≥ piso à vista (custo do prazo ≥ 0)', () => {
    const res = pisoComPrazo(cmc, a, [30, 60, 90], r)!;
    expect(res.piso).toBeGreaterThan(cmc / (1 - a));
    expect(res.custoRs).toBeGreaterThan(0);
    expect(res.prazoMedio).toBeCloseTo(60, 6);
  });

  it('gate de denominador: S − aliquota ≤ ε → null (não gera piso negativo/explosivo)', () => {
    // aliquota altíssima + prazo longo → S < aliquota → denominador negativo.
    expect(pisoComPrazo(100, 0.99, [180], r)).toBeNull();
  });
  it('guards → null', () => {
    expect(pisoComPrazo(0, a, [30], r)).toBeNull(); // cmc ≤ 0
    expect(pisoComPrazo(cmc, 1, [30], r)).toBeNull(); // aliquota ≥ 1
    expect(pisoComPrazo(cmc, a, [30], 0)).toBeNull(); // taxa ≤ 0
    expect(pisoComPrazo(cmc, a, [30], 1.2)).toBeNull(); // taxa ≥ 1 (unidade)
    expect(pisoComPrazo(cmc, a, [], r)).toBeNull(); // sem parcelas
    expect(pisoComPrazo(cmc, a, [200], r)).toBeNull(); // dia > 180 (defesa em profundidade)
  });
});

describe('avaliarReguaPreco — integração do custo do prazo (F2)', () => {
  const base = (over: Partial<ReguaPrecoInput>): ReguaPrecoInput => ({
    precoAtual: 124,
    cmc: 100,
    cmcConfiavel: true,
    aliquotaVenda: 0.18, // piso à vista = 121,95
    precosCliente: [130, 130, 130],
    comparaveis: [],
    caps: { alta: 0.1, media: 0.05 },
    prazoDias: null,
    custoCapitalAnual: null,
    ...over,
  });

  it('levanta o piso e o cap NÃO mascara (P1-D5): 124 fica acima do piso à vista mas abaixo do ajustado', () => {
    const semPrazo = avaliarReguaPreco(base({}));
    expect(semPrazo.abaixoPiso).toBe(false); // 124 > 121,95

    const comPrazo = avaliarReguaPreco(base({ prazoDias: [30, 60, 90], custoCapitalAnual: 0.1775 }));
    expect(comPrazo.pisoMC).toBeCloseTo(126.01, 1); // piso ajustado
    expect(comPrazo.abaixoPiso).toBe(true);
    expect(comPrazo.sinal).toBe('piso'); // early-return de piso vence o cap
    expect(comPrazo.reasonCodes).toContain('piso_ajustado_prazo');
    expect(comPrazo.recibos.some((r) => r.includes('custo do prazo'))).toBe(true);
    expect(comPrazo.disclaimers).toContain('Frete não considerado.'); // frete SEMPRE fora (P1-D6)
  });

  it('degrada honesto sem prazo: piso à vista + disclaimer "Prazo não considerado" + frete', () => {
    const r = avaliarReguaPreco(base({ prazoDias: null, custoCapitalAnual: null }));
    expect(r.pisoMC).toBeCloseTo(100 / (1 - 0.18), 6); // à vista, não levantado
    expect(r.disclaimers).toContain('Prazo de recebimento não considerado.');
    expect(r.disclaimers).toContain('Frete não considerado.');
    expect(r.reasonCodes).not.toContain('piso_ajustado_prazo');
  });

  it('cmc proxy (não confiável) NÃO aplica o prazo (não compõe incerteza)', () => {
    const r = avaliarReguaPreco(base({ cmcConfiavel: false, prazoDias: [30, 60, 90], custoCapitalAnual: 0.1775 }));
    expect(r.reasonCodes).not.toContain('piso_ajustado_prazo');
    expect(r.disclaimers).toContain('Prazo de recebimento não considerado.');
  });

  it('taxa ausente → degrada (NUNCA taxa 0)', () => {
    const r = avaliarReguaPreco(base({ prazoDias: [30, 60, 90], custoCapitalAnual: null }));
    expect(r.reasonCodes).not.toContain('piso_ajustado_prazo');
    expect(r.disclaimers).toContain('Prazo de recebimento não considerado.');
  });

  it('condição à vista pura [0] é APLICADA (lift 0), não degradada', () => {
    const r = avaliarReguaPreco(base({ precoAtual: 130, prazoDias: [0], custoCapitalAnual: 0.1775 }));
    expect(r.reasonCodes).toContain('piso_ajustado_prazo');
    expect(r.pisoMC).toBeCloseTo(100 / (1 - 0.18), 6); // lift 0
    expect(r.disclaimers).not.toContain('Prazo de recebimento não considerado.');
  });
});
