import { describe, it, expect } from 'vitest';
import { agruparSemanasFluxo } from '../fluxo-caixa-semanas';
import { makeFluxoDia } from './factories';

// Hoje = quarta, 09/09/2026. Semana ISO-domingo corrente: 06/09 (dom) a 12/09 (sáb).
const HOJE = '2026-09-09';

// ⚠️ A fixture PRECISA ter semanas passadas COM movimento: é exatamente o dinheiro que já
// está dentro do `saldoCC` e que a versão antiga somava por cima dele. Uma fixture só de
// futuro passa verde com o defeito intacto.
const dias = [
  // Semana de 30/08 — inteiramente PASSADA, com movimento realizado.
  makeFluxoDia({ data: '2026-09-01', entradas_realizadas: 100_000, saidas_realizadas: 40_000 }),
  // Semana CORRENTE — mistura dias já realizados (dentro do saldoCC) com dias a vencer.
  makeFluxoDia({ data: '2026-09-07', entradas_realizadas: 20_000, saidas_realizadas: 5_000 }),
  makeFluxoDia({ data: '2026-09-11', entradas_previstas: 8_000, saidas_previstas: 3_000 }),
  // Semana de 13/09 — FUTURA.
  makeFluxoDia({ data: '2026-09-16', entradas_previstas: 10_000, saidas_previstas: 25_000 }),
];

describe('agruparSemanasFluxo — a âncora é o presente', () => {
  it('não conta o passado duas vezes: a projeção parte do saldo de hoje', () => {
    const semanas = agruparSemanasFluxo(dias, { hoje: HOJE, saldoCC: 500_000 });
    const [passada, corrente, futura] = semanas;

    // Semana passada: o saldo dela é história, não projeção.
    expect(passada.label).toBe('30/08');
    expect(passada.saldo).toBe(60_000);
    expect(passada.acumulado).toBeNull();
    expect(passada.projetada).toBe(false);

    // Semana corrente: 500k + SÓ a parte a vencer (8k − 3k). Os 15k realizados de 07/09 já
    // estão no saldoCC. A versão antiga somava tudo e dava 580k.
    expect(corrente.acumulado).toBe(505_000);
    expect(corrente.projetada).toBe(true);
    // O movimento exibido continua sendo o da semana inteira — o que não pode vazar para a
    // projeção é o pedaço já realizado.
    expect(corrente.saldo).toBe(20_000);

    // Semana seguinte parte do fechamento projetado da corrente.
    expect(futura.acumulado).toBe(490_000);
  });

  it('cenário do parecer Codex: 1.000 de saldo, +200 já realizado na semana, −300 a vencer → 700', () => {
    const semanas = agruparSemanasFluxo(
      [
        makeFluxoDia({ data: '2026-09-07', entradas_realizadas: 200 }),
        makeFluxoDia({ data: '2026-09-11', saidas_previstas: 300 }),
      ],
      { hoje: HOJE, saldoCC: 1_000 },
    );
    expect(semanas).toHaveLength(1);
    expect(semanas[0].acumulado).toBe(700);
  });

  it('o dia de HOJE conta como futuro: o previsto dele ainda não está no saldo em conta', () => {
    const semanas = agruparSemanasFluxo(
      [makeFluxoDia({ data: HOJE, entradas_previstas: 1_000, entradas_realizadas: 9_999 })],
      { hoje: HOJE, saldoCC: 100 },
    );
    // Usa o PREVISTO de hoje (1.000) e ignora o realizado de hoje — que a posição bancária
    // consultada já reflete.
    expect(semanas[0].acumulado).toBe(1_100);
  });

  it('saldo indisponível → projeção sem âncora, "—" em vez de curva a partir de zero', () => {
    const semanas = agruparSemanasFluxo(dias, { hoje: HOJE, saldoCC: null });
    expect(semanas.map(s => s.acumulado)).toEqual([null, null, null]);
    // O movimento medido continua disponível: o que falta é a âncora, não os fluxos.
    expect(semanas[1].saldo).toBe(20_000);
  });

  it('saldo zero CONHECIDO é fato medido, não ausência', () => {
    const semanas = agruparSemanasFluxo(dias, { hoje: HOJE, saldoCC: 0 });
    expect(semanas[1].acumulado).toBe(5_000);
    expect(semanas[2].acumulado).toBe(-10_000);
  });

  it('saldo negativo é âncora legítima (conta garantida) — prod tem duas empresas assim', () => {
    const semanas = agruparSemanasFluxo(dias, { hoje: HOJE, saldoCC: -333_393 });
    expect(semanas[1].acumulado).toBe(-328_393);
  });

  it('dias fora de ordem não quebram o agrupamento', () => {
    const semanas = agruparSemanasFluxo([...dias].reverse(), { hoje: HOJE, saldoCC: 500_000 });
    expect(semanas.map(s => s.label)).toEqual(['30/08', '06/09', '13/09']);
    expect(semanas[1].acumulado).toBe(505_000);
  });
});
