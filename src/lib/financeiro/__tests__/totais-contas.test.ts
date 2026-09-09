import { describe, it, expect } from 'vitest';
import { totaisReceber, totaisPagar } from '../totais-contas';
import {
  BAIXA_OMIE_LIST,
  MOTIVO_BAIXA_NAO_INGERIDA,
  type ProcedenciaBaixa,
} from '../procedencia-baixa';

/**
 * Os totalizadores de `/financeiro` (abas Contas a Receber / a Pagar) somavam `valor_recebido`,
 * `valor_pago` e `saldo` crus de `fin_contas_{receber,pagar}` — colunas que o LIST do Omie nunca
 * preenche (#396: 0 em 44.524/44.524 CR e 16.125/16.125 CP, medido em prod 2026-09-09). O card
 * "Recebido" exibia R$ 0,00 sobre R$ 27,8M de títulos com status RECEBIDO, e o card "Saldo" o
 * valor de face inteiro, porque `saldo` é coluna GERADA a partir do mesmo subtraendo zerado.
 *
 * ⚠️ O eixo destes testes é que o gatilho é a PROCEDÊNCIA, nunca o valor: o último bloco é o
 * CONTROLE, e é ele que impede a correção de mentir no sentido oposto.
 */

/** A mesma tela no dia em que a ingestão da baixa existir — ver `procedencia-baixa.ts`. */
const FONTE_COM_BAIXA: ProcedenciaBaixa = {
  fonte: 'teste/fonte que ingere a baixa',
  ingereBaixa: true,
  motivo: null,
};

/** Recebíveis liquidados como o acervo os entrega hoje: baixa 0, saldo = documento cheio. */
const receberLiquidado = [
  { valor_documento: 1_000, valor_recebido: 0, saldo: 1_000 },
  { valor_documento: 27_854_279.84, valor_recebido: 0, saldo: 27_854_279.84 },
];

const pagarLiquidado = [
  { valor_documento: 2_000, valor_pago: 0, saldo: 2_000 },
  { valor_documento: 28_924_255.51, valor_pago: 0, saldo: 28_924_255.51 },
];

describe('totais de contas — fonte sem ingestão da baixa', () => {
  it('degrada recebido e saldo para null, e diz por quê', () => {
    const t = totaisReceber(receberLiquidado, BAIXA_OMIE_LIST);

    expect(t.baixa).toBeNull();
    expect(t.saldo).toBeNull();
    expect(t.procedencia.motivo).toBe(MOTIVO_BAIXA_NAO_INGERIDA);
  });

  it('degrada pago e saldo para null no ramo de contas a pagar', () => {
    const t = totaisPagar(pagarLiquidado, BAIXA_OMIE_LIST);

    expect(t.baixa).toBeNull();
    expect(t.saldo).toBeNull();
    expect(t.procedencia.motivo).toBe(MOTIVO_BAIXA_NAO_INGERIDA);
  });

  it('mantém o valor de documento, que é medido e não depende da baixa', () => {
    expect(totaisReceber(receberLiquidado, BAIXA_OMIE_LIST).valor).toBeCloseTo(27_855_279.84, 2);
    expect(totaisPagar(pagarLiquidado, BAIXA_OMIE_LIST).valor).toBeCloseTo(28_926_255.51, 2);
  });
});

describe('CONTROLE — fonte confiável: zero é FATO, não indisponibilidade', () => {
  it('soma 0 com fonte que ingere a baixa continua 0 — nunca null', () => {
    const t = totaisReceber(
      [{ valor_documento: 1_000, valor_recebido: 0, saldo: 1_000 }],
      FONTE_COM_BAIXA,
    );

    expect(t.baixa).toBe(0);
    expect(t.saldo).toBe(1_000);
    expect(t.procedencia.motivo).toBeNull();
  });

  it('soma 0 com fonte que ingere a baixa continua 0 no ramo de contas a pagar', () => {
    const t = totaisPagar(
      [{ valor_documento: 2_000, valor_pago: 0, saldo: 2_000 }],
      FONTE_COM_BAIXA,
    );

    expect(t.baixa).toBe(0);
    expect(t.saldo).toBe(2_000);
    expect(t.procedencia.motivo).toBeNull();
  });

  it('soma não-zero com fonte que ingere a baixa passa intacta', () => {
    const t = totaisReceber(
      [{ valor_documento: 1_000, valor_recebido: 400, saldo: 600 }],
      FONTE_COM_BAIXA,
    );

    expect(t.baixa).toBe(400);
    expect(t.saldo).toBe(600);
  });
});

describe('lista vazia', () => {
  it('não fabrica baixa a partir da ausência de linhas quando a fonte não ingere', () => {
    expect(totaisReceber([], BAIXA_OMIE_LIST).baixa).toBeNull();
  });

  it('com fonte confiável, lista vazia soma 0 — que é o fato', () => {
    expect(totaisReceber([], FONTE_COM_BAIXA).baixa).toBe(0);
  });
});
