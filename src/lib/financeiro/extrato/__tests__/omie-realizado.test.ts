import { describe, expect, it } from 'vitest';
import { montarMovimentoOmie, MOVIMENTO_OMIE_FECHADO, type LinhaOmieDiaRpc } from '../omie-realizado';

const linha = (o: Partial<LinhaOmieDiaRpc> = {}): LinhaOmieDiaRpc => ({
  data: '2026-10-05',
  creditos_centavos: 15000,
  debitos_centavos: 3000,
  regra_versao: 'v1',
  creditos_calibrado: true,
  debitos_calibrado: true,
  ...o,
});

describe('montarMovimentoOmie — gate fail-closed por lado', () => {
  it('resposta vazia/nula = os dois lados fechados', () => {
    expect(montarMovimentoOmie([])).toEqual(MOVIMENTO_OMIE_FECHADO);
    expect(montarMovimentoOmie(null)).toEqual(MOVIMENTO_OMIE_FECHADO);
  });

  it('calibrado nos dois lados expõe os centavos (string do bigint vira número)', () => {
    const m = montarMovimentoOmie([linha({ creditos_centavos: '15000' })]);
    expect(m.creditosCalibrado && m.debitosCalibrado).toBe(true);
    expect(m.porDia['2026-10-05']).toMatchObject({ creditos: 15000, debitos: 3000, creditosCalibrado: true, debitosCalibrado: true });
    expect(m.regraVersao).toBe('v1');
  });

  it('número com flag false é DESCARTADO (o servidor errar não vaza para a tela)', () => {
    const m = montarMovimentoOmie([linha({ debitos_calibrado: false })]);
    expect(m.creditosCalibrado).toBe(true);
    expect(m.debitosCalibrado).toBe(false);
    expect(m.porDia['2026-10-05']).toMatchObject({ creditos: 15000, debitos: null, debitosCalibrado: false });
  });

  it('flag ausente (null) = não calibrado', () => {
    const m = montarMovimentoOmie([linha({ creditos_calibrado: null })]);
    expect(m.creditosCalibrado).toBe(false);
    expect(m.porDia['2026-10-05']).toMatchObject({ creditos: null, creditosCalibrado: false });
  });

  it('o gate é POR DIA: dia fora do período calibrado fecha só aquele dia', () => {
    const m = montarMovimentoOmie([linha(), linha({ data: '2026-11-05', creditos_calibrado: false, debitos_calibrado: false })]);
    expect(m.porDia['2026-10-05']).toMatchObject({ creditos: 15000, creditosCalibrado: true });
    expect(m.porDia['2026-11-05']).toMatchObject({ creditos: null, debitos: null, creditosCalibrado: false });
  });

  it('dia sem movimento Omie (NULL) segue null mesmo calibrado — nunca 0', () => {
    const m = montarMovimentoOmie([linha({ creditos_centavos: null, debitos_centavos: null })]);
    expect(m.porDia['2026-10-05']).toMatchObject({ creditos: null, debitos: null });
  });

  it('zero real dentro de dia com movimento é 0', () => {
    expect(montarMovimentoOmie([linha({ debitos_centavos: 0 })]).porDia['2026-10-05']?.debitos).toBe(0);
  });

  it('versões de regra misturadas na mesma resposta fecham os dois lados', () => {
    const m = montarMovimentoOmie([linha(), linha({ data: '2026-10-06', regra_versao: 'v2' })]);
    expect(m.creditosCalibrado || m.debitosCalibrado).toBe(false);
    expect(m.porDia['2026-10-05']).toMatchObject({ creditos: null, debitos: null, creditosCalibrado: false, debitosCalibrado: false });
  });

  it('valor não inteiro/inválido vira null, nunca número inventado', () => {
    expect(montarMovimentoOmie([linha({ creditos_centavos: 'abc' })]).porDia['2026-10-05']?.creditos).toBeNull();
    expect(montarMovimentoOmie([linha({ creditos_centavos: 1.5 })]).porDia['2026-10-05']?.creditos).toBeNull();
    expect(montarMovimentoOmie([linha({ creditos_centavos: '   ' })]).porDia['2026-10-05']?.creditos).toBeNull();
  });
});
