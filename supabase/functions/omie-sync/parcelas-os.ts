// As parcelas da OS mandada ao Omie (omie-sync), com o vencimento no dia de NEGÓCIO (America/Sao_Paulo).
//
// POR QUE EXISTE — a classe (ii) do fuso, fase 3 (docs/historico/hoje-sp-typescript-e-data-ciclo.md).
// O `buildParcelas` do index.ts somava os prazos com `setDate()`/`getDate()` sobre `new Date()`: no servidor
// (UTC), a OS criada das 21:00 às 23:59 BRT ia ao Omie com TODO vencimento um dia adiante — a à vista
// vencendo amanhã. Aqui o dia de partida é HOJE em SP e a soma é de calendário. Prazos e percentuais são
// os de sempre. Lógica PURA (o instante é injetável); testes em parcelas-os_test.ts.
import { hojeSP, paraDataOmie, somarDias } from "../_shared/hoje-sp.ts";

const PRAZOS: Record<string, number[]> = {
  'a_vista': [0],
  '30dd': [30],
  '30_60dd': [30, 60],
  '30_60_90dd': [30, 60, 90],
  '28dd': [28],
  '28_56dd': [28, 56],
  '28_56_84dd': [28, 56, 84],
};

export function montarParcelasOS(
  metodo: string,
  agora: Date,
): { parcelas: Array<Record<string, unknown>>; nQtdeParc: number } {
  const hoje = hojeSP(agora);
  const dias = PRAZOS[metodo] || [0];
  const percentual = Math.round((100 / dias.length) * 100) / 100;

  return {
    nQtdeParc: dias.length,
    parcelas: dias.map((d, i) => {
      const parc: Record<string, unknown> = {
        nParcela: i + 1,
        dDtVenc: paraDataOmie(somarDias(hoje, d)),
        nPercentual: i === dias.length - 1 ? Math.round((100 - percentual * (dias.length - 1)) * 100) / 100 : percentual,
      };
      // Omie exige nValor > 0 se presente; omitir quando total é 0 (preço ainda não definido)
      return parc;
    }),
  };
}

// Rateio do TOTAL da OS pelas parcelas, em CENTAVOS INTEIROS (PR 2.1 da rodada 3 do Novo Pedido).
// O código antigo dividia a última parcela em REAIS inteiros (`Math.floor(total / n)`): R$ 100 em 3 vezes
// ia ao Omie como 33,33 + 33,33 + 34,00 = R$ 100,66. Aqui cada parcela recebe ⌊centavos / n⌋ e a ÚLTIMA
// leva o saldo, então a soma é SEMPRE o total, ao centavo. Total não finito, ≤ 0 ou n < 1 → lança: o
// chamador só pede rateio quando há total > 0 (o Omie exige nValor > 0), e número inventado aqui é PV errado.
export function ratearTotalEmParcelas(totalReais: number, n: number): number[] {
  if (!Number.isFinite(totalReais) || totalReais <= 0) {
    throw new Error(`ratearTotalEmParcelas: total inválido (${totalReais})`);
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`ratearTotalEmParcelas: quantidade de parcelas inválida (${n})`);
  }
  const centavos = Math.round(totalReais * 100);
  const base = Math.floor(centavos / n);
  const valores: number[] = [];
  for (let i = 0; i < n - 1; i++) valores.push(base / 100);
  valores.push((centavos - base * (n - 1)) / 100);
  return valores;
}
