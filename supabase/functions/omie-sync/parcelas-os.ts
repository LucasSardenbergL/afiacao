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
// leva o saldo, então a soma é SEMPRE o total, ao centavo. Lança (nunca inventa parcela) quando:
//  - o total não é finito ou é ≤ 0 (o chamador só rateia total > 0);
//  - n não é inteiro ≥ 1;
//  - há menos centavos que parcelas: o Omie exige nValor > 0 em CADA parcela (Codex no PR 2.1).
// O total vem em reais e pode trazer meio centavo (preço × quantidade sem arredondar no carrinho): o
// arredondamento é meio-para-cima no DECIMAL — `toFixed(6)` tira o ruído binário (1,005 × 100 = 100,4999…).
export function ratearTotalEmParcelas(totalReais: number, n: number): number[] {
  if (!Number.isFinite(totalReais) || totalReais <= 0) {
    throw new Error(`ratearTotalEmParcelas: total inválido (${totalReais})`);
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`ratearTotalEmParcelas: quantidade de parcelas inválida (${n})`);
  }
  const centavos = Math.round(Number((totalReais * 100).toFixed(6)));
  if (centavos < n) {
    throw new Error(`ratearTotalEmParcelas: ${centavos} centavo(s) não cabem em ${n} parcela(s) positivas`);
  }
  const base = Math.floor(centavos / n);
  const valores: number[] = [];
  for (let i = 0; i < n - 1; i++) valores.push(base / 100);
  valores.push((centavos - base * (n - 1)) / 100);
  return valores;
}

// As parcelas da OS com `nValor` E `nPercentual` coerentes: o percentual sai do VALOR rateado (2 casas, o
// saldo na última fecha 100), não da divisão igual de 100% — R$ 50 em 3x é 16,66/16,66/16,68, ou seja
// 33,32/33,32/33,36%, e o payload ia com 33,33/33,33/33,34% (Codex no PR 2.1).
export function parcelasComValor(
  parcelas: Array<Record<string, unknown>>,
  totalReais: number,
): Array<Record<string, unknown>> {
  const valores = ratearTotalEmParcelas(totalReais, parcelas.length);
  const centavos = valores.reduce((s, v) => s + Math.round(v * 100), 0);
  // Percentual em centésimos de ponto (10000 = 100%): ⌊valor/total⌋ nas primeiras, saldo na última.
  const pcts = valores.map((v) => Math.floor((Math.round(v * 100) * 10000) / centavos));
  pcts[pcts.length - 1] = 10000 - pcts.slice(0, -1).reduce((s, p) => s + p, 0);
  return parcelas.map((p, i) => ({ ...p, nValor: valores[i], nPercentual: pcts[i] / 100 }));
}
