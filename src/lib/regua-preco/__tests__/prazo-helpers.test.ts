import { describe, it, expect } from 'vitest';
import { parsePrazoRecebimento } from '../prazo-helpers';
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

// `custoCapitalPrazo` e `pisoComPrazo` NÃO existem mais aqui (FU4-F fase 2): ambos precisavam do
// cmc, que é justamente o que a vendedora deixou de receber. A fórmula virou
// `private.regua_piso_calc` e a taxa é lida pelo servidor. A cobertura migrou para
// db/test-authz-custo-fu4f-fase2-regua.sh — A18 (piso com prazo = 13.6684, calculado FORA do SQL
// para não ser circular), A19 (prazo_aplicado), A22/A23 (dia > 180 degrada para o à vista).
// A20/A21 são novos e provam o que nenhum teste TS conseguia: que o prazo mudar de lado
// (cliente → servidor) altera o SINAL, não só o número.

describe('avaliarReguaPreco — integração do custo do prazo (F2)', () => {
  // piso à vista = 100/(1-0,18) = 121,95; com prazo [30,60,90] @17,75% a.a. = 126,01.
  // Agora AMBOS vêm decididos do servidor — aqui prova-se a leitura do veredito, não a fórmula.
  const A_VISTA = 100 / (1 - 0.18);
  const COM_PRAZO = 126.01;
  const base = (over: Partial<ReguaPrecoInput>): ReguaPrecoInput => ({
    precoAtual: 124,
    piso: { abaixoPiso: false, disponivel: true, piso: A_VISTA, gapPct: null,
            cmcConfiavel: true, prazoAplicado: false },
    precosCliente: [130, 130, 130],
    comparaveis: [],
    caps: { alta: 0.1, media: 0.05 },
    prazoDias: null,
    ...over,
  });

  it('levanta o piso e o cap NÃO mascara (P1-D5): 124 fica acima do piso à vista mas abaixo do ajustado', () => {
    const semPrazo = avaliarReguaPreco(base({}));
    expect(semPrazo.abaixoPiso).toBe(false); // 124 > 121,95

    const comPrazo = avaliarReguaPreco(base({
      prazoDias: [30, 60, 90],
      piso: { abaixoPiso: true, disponivel: true, piso: COM_PRAZO, gapPct: null,
              cmcConfiavel: true, prazoAplicado: true },
    }));
    expect(comPrazo.pisoMC).toBeCloseTo(126.01, 1); // piso ajustado
    expect(comPrazo.abaixoPiso).toBe(true);
    expect(comPrazo.sinal).toBe('piso'); // early-return de piso vence o cap
    expect(comPrazo.reasonCodes).toContain('piso_ajustado_prazo');
    expect(comPrazo.recibos.some((r) => r.includes('custo do prazo'))).toBe(true);
    expect(comPrazo.disclaimers).toContain('Frete não considerado.'); // frete SEMPRE fora (P1-D6)
  });

  it('degrada honesto sem prazo: piso à vista + disclaimer "Prazo não considerado" + frete', () => {
    const r = avaliarReguaPreco(base({ prazoDias: null }));
    expect(r.pisoMC).toBeCloseTo(100 / (1 - 0.18), 6); // à vista, não levantado
    expect(r.disclaimers).toContain('Prazo de recebimento não considerado.');
    expect(r.disclaimers).toContain('Frete não considerado.');
    expect(r.reasonCodes).not.toContain('piso_ajustado_prazo');
  });

  // "cmc proxy não aplica o prazo" e "taxa ausente → degrada" saíram daqui: são decisões do
  // SERVIDOR agora (regua_piso_calc degrada para o piso à vista em qualquer guard que falhe, e
  // fin_regua_custo_capital devolve NULL em config ausente/absurda). O cliente não tem mais a
  // alavanca para simulá-las — testá-las aqui seria testar o mock, não o comportamento.

  it('condição à vista pura [0] é APLICADA (lift 0), não degradada', () => {
    const r = avaliarReguaPreco(base({
      precoAtual: 130, prazoDias: [0],
      piso: { abaixoPiso: false, disponivel: true, piso: A_VISTA, gapPct: null,
              cmcConfiavel: true, prazoAplicado: true },
    }));
    expect(r.reasonCodes).toContain('piso_ajustado_prazo');
    expect(r.pisoMC).toBeCloseTo(A_VISTA, 6); // lift 0
    expect(r.disclaimers).not.toContain('Prazo de recebimento não considerado.');
  });

  it('prazo aplicado com o número MASCARADO: o recibo cita os dias, nunca o valor', () => {
    const r = avaliarReguaPreco(base({
      precoAtual: 124, prazoDias: [30, 60, 90],
      piso: { abaixoPiso: true, disponivel: true, piso: null, gapPct: null,
              cmcConfiavel: true, prazoAplicado: true },
    }));
    expect(r.recibos.some((x) => x.includes('30/60/90 dias'))).toBe(true);
    expect(r.recibos.join(' ')).not.toMatch(/R\$/);
    expect(r.pisoMC).toBeNull();
  });
});
