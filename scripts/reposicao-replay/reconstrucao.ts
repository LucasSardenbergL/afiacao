// Estado inicial do replay (spec §5.2 e §5.9 "Estado inicial"): reconstrução contábil retroativa do estoque físico.
//   estoque_fim(d) = saldo_hoje − Σ eventos após d,  eventos = −vendas(no escopo) + recebimentos (chegada em t4).
// Reaproveita `reconstruirEstoque` do orçamento de compra (mesma conta, mesma convenção de fim de dia).
// Horizonte = TODOS os dias corridos de INICIO_AQUECIMENTO até a data da extração (venda de sábado e recebimento de
// fim de semana contam). `estoqueInicial` é o saldo de ABERTURA do 1º dia (antes dos eventos de INICIO_AQUECIMENTO).
//
// Cenários:
//  - 'reconstruido': abertura reconstruída + ajuste mínimo que evita negativo, calculado SÓ com o caminho até
//    FIM_CALIBRACAO (abertura e fim de cada dia). Um negativo que só aparece na avaliação NÃO é ajustado: é reportado
//    por `negativosNaAvaliacao` (erro medido do simulador).
//  - 'piso_zero': abertura reconstruída sem o ajuste, com negativo truncado em 0 (= max(0, cru)).
// Honestidade sobre o que NÃO é independente da avaliação: a âncora é o saldo de HOJE (fim da avaliação); o fluxo líquido
// da avaliação entra na abertura. O que a regra garante é que o AJUSTE não olha o caminho da avaliação.
// SKU sem `saldoHoje` não tem como ser reconstruído: fica FORA do mapa (nunca 0) e vai para `diagnostico.semSaldo`.
import { addDias, diffDias } from '../../src/lib/reposicao/orcamento-compra/datas';
import { reconstruirEstoque } from '../../src/lib/reposicao/orcamento-compra/demanda';
import { INICIO_AQUECIMENTO, JANELAS } from './config';
import type { Dados, Data } from './tipos';

export type CenarioInicial = 'reconstruido' | 'piso_zero';
export type DadosReconstrucao = Pick<Dados, 'vendas' | 'recebimentos' | 'skus' | 'dataExtracao'>;

/** Folga numérica: abaixo disso o "negativo" é ruído de ponto flutuante. */
const EPS = 1e-9;

export interface ReconstrucaoSku {
  sku: string;
  /** Saldo de abertura do 1º dia, cru (pode ser negativo). */
  aberturaCrua: number;
  /** Fim de cada dia corrente de INICIO_AQUECIMENTO até a extração, cru (sem ajuste). */
  fimDia: number[];
  /** Ajuste mínimo que evita negativo, só com o caminho até FIM_CALIBRACAO. */
  ajuste: number;
  /** Nenhum dia negativo (abertura e fins de dia) em TODO o horizonte, sem ajuste. */
  fecha: boolean;
}

export interface Reconstrucao {
  itens: Map<string, ReconstrucaoSku>;
  semSaldo: { sku: string; motivo: string }[];
}

export function reconstruirSkus(dados: DadosReconstrucao): Reconstrucao {
  const ini = INICIO_AQUECIMENTO;
  const n = diffDias(ini, dados.dataExtracao) + 1;
  const idxCalibFim = Math.min(n - 1, diffDias(ini, JANELAS.calibracaoFim));
  const dem = new Map<string, number[]>();
  const rcb = new Map<string, number[]>();
  const slot = (m: Map<string, number[]>, sku: string): number[] => {
    let a = m.get(sku);
    if (!a) m.set(sku, (a = new Array<number>(n).fill(0)));
    return a;
  };
  for (const v of dados.vendas) {
    if (!v.noEscopo) continue;
    const i = diffDias(ini, v.data);
    if (i >= 0 && i < n) slot(dem, v.sku)[i] += v.quantidade;
  }
  for (const r of dados.recebimentos) {
    const i = diffDias(ini, r.data);
    if (i >= 0 && i < n) slot(rcb, r.sku)[i] += r.quantidade;
  }

  const itens = new Map<string, ReconstrucaoSku>();
  const semSaldo: { sku: string; motivo: string }[] = [];
  for (const s of [...dados.skus.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))) {
    if (s.saldoHoje === null) {
      semSaldo.push({ sku: s.sku, motivo: 'SALDO_HOJE_AUSENTE' });
      continue;
    }
    const d = dem.get(s.sku) ?? new Array<number>(n).fill(0);
    const r = rcb.get(s.sku) ?? new Array<number>(n).fill(0);
    const fimDia = reconstruirEstoque(s.saldoHoje, d, r);
    const aberturaCrua = fimDia[0] - r[0] + d[0];
    let minCalib = aberturaCrua;
    for (let t = 0; t <= idxCalibFim; t++) minCalib = Math.min(minCalib, fimDia[t]);
    let minTudo = minCalib;
    for (let t = idxCalibFim + 1; t < n; t++) minTudo = Math.min(minTudo, fimDia[t]);
    itens.set(s.sku, {
      sku: s.sku,
      aberturaCrua,
      fimDia,
      ajuste: minCalib < -EPS ? -minCalib : 0,
      fecha: minTudo >= -EPS,
    });
  }
  return { itens, semSaldo };
}

/** Estoque físico de abertura de INICIO_AQUECIMENTO por SKU. SKU sem saldo de hoje fica ausente. */
export function estoqueInicial(dados: DadosReconstrucao, cenario: CenarioInicial): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of reconstruirSkus(dados).itens.values()) {
    out.set(it.sku, cenario === 'reconstruido' ? it.aberturaCrua + it.ajuste : Math.max(0, it.aberturaCrua));
  }
  return out;
}

/**
 * Negativos que sobram NA AVALIAÇÃO (caminho do cenário 'reconstruido', já com o ajuste da calibração): o pior dia de
 * cada SKU (1º dia, se houver empate). Reportados, nunca ajustados.
 */
export function negativosNaAvaliacao(dados: DadosReconstrucao): { sku: string; data: Data; valor: number }[] {
  const ini = INICIO_AQUECIMENTO;
  const de = Math.max(0, diffDias(ini, JANELAS.avaliacaoIni));
  const out: { sku: string; data: Data; valor: number }[] = [];
  for (const it of reconstruirSkus(dados).itens.values()) {
    let pior = 0;
    let idx = -1;
    for (let t = de; t < it.fimDia.length; t++) {
      if (addDias(ini, t) > JANELAS.avaliacaoFim) break;
      const v = it.fimDia[t] + it.ajuste;
      if (v < -EPS && v < pior) {
        pior = v;
        idx = t;
      }
    }
    if (idx >= 0) out.push({ sku: it.sku, data: addDias(ini, idx), valor: pior });
  }
  return out;
}

export interface DiagnosticoEstadoInicial {
  /** SKUs reconstruíveis (com saldo de hoje). */
  total: number;
  /** Destes, quantos não ficam negativos em nenhum dia do horizonte inteiro. */
  fecham: number;
  /** fecham / total; null se total = 0. */
  pctFecham: number | null;
  semSaldo: { sku: string; motivo: string }[];
  /** SKUs com ajuste > 0 (déficit na calibração). */
  ajustes: { sku: string; ajuste: number }[];
}

export function diagnosticoEstadoInicial(dados: DadosReconstrucao): DiagnosticoEstadoInicial {
  const { itens, semSaldo } = reconstruirSkus(dados);
  const lista = [...itens.values()];
  const fecham = lista.filter((i) => i.fecha).length;
  return {
    total: lista.length,
    fecham,
    pctFecham: lista.length === 0 ? null : fecham / lista.length,
    semSaldo,
    ajustes: lista.filter((i) => i.ajuste > 0).map((i) => ({ sku: i.sku, ajuste: i.ajuste })),
  };
}
