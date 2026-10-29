// Estado inicial do replay (spec §5.2 e §5.9 "Estado inicial").
// ÂNCORA (achado 1 do Codex, revoga a R10): a posição de estoque DATADA do Omie no fim da véspera do aquecimento
// (`posicao_omie_<INICIO_AQUECIMENTO − 1>.csv`, extrair-omie-posicao.ts) É o saldo de abertura de INICIO_AQUECIMENTO, e o
// caminho é reconstruído PARA A FRENTE: fim(d) = abertura + Σ recebimentos − Σ vendas(no escopo) até d. A abertura não
// usa nenhum evento, então nada posterior a 30/04 a altera. SKU sem posição fica FORA (motivo POSICAO_OMIE_AUSENTE), nunca
// 0 nem saldo de hoje. A posição de 30/04 é só CONFERÊNCIA (`conferirPosicao`).
// Sem a âncora (CSV ainda não extraído) cai no modo legado `saldo_hoje` (reconstrução retroativa a partir do saldo de
// HOJE, via `reconstruirEstoque` do orçamento de compra): esse modo DEPENDE da avaliação e é reportado em `ancora`.
// Horizonte = TODOS os dias corridos de INICIO_AQUECIMENTO até a data da extração (venda de sábado e recebimento de
// fim de semana contam). `estoqueInicial` é o saldo de ABERTURA do 1º dia (antes dos eventos de INICIO_AQUECIMENTO).
//
// Cenários:
//  - 'reconstruido': abertura + ajuste mínimo que evita negativo, calculado SÓ com o caminho até FIM_CALIBRACAO
//    (abertura e fim de cada dia). Um negativo que só aparece na avaliação NÃO é ajustado: é reportado por
//    `negativosNaAvaliacao` (erro medido do simulador). No modo ÂNCORA (R31) não há ajuste: a abertura é a medição, e o
//    caminho para a frente de out/25 a jan/26 não tem recebimento (o histórico começa em 28/01/26), então `fecha` e os
//    negativos desse modo são só informativos; a prova do modo âncora é a conferência 31/01 → 30/04.
//  - 'piso_zero': abertura sem o ajuste, com negativo truncado em 0 (= max(0, cru)).
import { addDias, diffDias } from '../../src/lib/reposicao/orcamento-compra/datas';
import { reconstruirEstoque } from '../../src/lib/reposicao/orcamento-compra/demanda';
import { INICIO_AQUECIMENTO, JANELAS } from './config';
import type { Dados, Data } from './tipos';

export type CenarioInicial = 'reconstruido' | 'piso_zero';
export type DadosReconstrucao = Pick<Dados, 'vendas' | 'recebimentos' | 'skus' | 'dataExtracao'> & {
  posicaoAbertura?: Map<string, number> | null;
  /** Posição do Omie no fim do aquecimento (31/01): início da conferência (R31). */
  posicaoAquecimentoFim?: Map<string, number> | null;
  /** Posição do Omie no fim da calibração (30/04): fim da conferência (R31). */
  posicaoConferencia?: Map<string, number> | null;
};
export type Ancora = 'posicao_omie' | 'saldo_hoje';

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
  ancora: Ancora;
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

  const posicao = dados.posicaoAbertura ?? null;
  const itens = new Map<string, ReconstrucaoSku>();
  const semSaldo: { sku: string; motivo: string }[] = [];
  for (const s of [...dados.skus.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))) {
    const d = dem.get(s.sku) ?? new Array<number>(n).fill(0);
    const r = rcb.get(s.sku) ?? new Array<number>(n).fill(0);
    let fimDia: number[];
    let aberturaCrua: number;
    if (posicao) {
      const a = posicao.get(s.sku);
      if (a === undefined) {
        semSaldo.push({ sku: s.sku, motivo: 'POSICAO_OMIE_AUSENTE' });
        continue;
      }
      aberturaCrua = a;
      fimDia = new Array<number>(n);
      let x = a;
      for (let t = 0; t < n; t++) fimDia[t] = x = x + r[t] - d[t];
    } else {
      if (s.saldoHoje === null) {
        semSaldo.push({ sku: s.sku, motivo: 'SALDO_HOJE_AUSENTE' });
        continue;
      }
      fimDia = reconstruirEstoque(s.saldoHoje, d, r);
      aberturaCrua = fimDia[0] - r[0] + d[0];
    }
    let minCalib = aberturaCrua;
    for (let t = 0; t <= idxCalibFim; t++) minCalib = Math.min(minCalib, fimDia[t]);
    let minTudo = minCalib;
    for (let t = idxCalibFim + 1; t < n; t++) minTudo = Math.min(minTudo, fimDia[t]);
    itens.set(s.sku, {
      sku: s.sku,
      aberturaCrua,
      fimDia,
      // R31: no modo âncora a abertura é MEDIDA; o ajuste só existe para a reconstrução a partir de saldo
      ajuste: !posicao && minCalib < -EPS ? -minCalib : 0,
      fecha: minTudo >= -EPS,
    });
  }
  return { ancora: posicao ? 'posicao_omie' : 'saldo_hoje', itens, semSaldo };
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
  /** De onde vem a abertura: posição datada do Omie (§5.9) ou o modo legado saldo de hoje (depende da avaliação). */
  ancora: Ancora;
  /** SKUs reconstruíveis (com saldo de hoje). */
  total: number;
  /** Destes, quantos não ficam negativos em nenhum dia do horizonte inteiro. */
  fecham: number;
  /** fecham / total; null se total = 0. */
  pctFecham: number | null;
  semSaldo: { sku: string; motivo: string }[];
  /** Conferência 31/01 → 30/04 contra as posições do Omie (R31); null sem as duas posições. */
  conferencia: ConferenciaPosicao | null;
  /** SKUs com ajuste > 0 (déficit na calibração). */
  ajustes: { sku: string; ajuste: number }[];
}

export function diagnosticoEstadoInicial(dados: DadosReconstrucao): DiagnosticoEstadoInicial {
  const { ancora, itens, semSaldo } = reconstruirSkus(dados);
  const lista = [...itens.values()];
  const fecham = lista.filter((i) => i.fecha).length;
  return {
    ancora,
    total: lista.length,
    fecham,
    pctFecham: lista.length === 0 ? null : fecham / lista.length,
    semSaldo,
    ajustes: lista.filter((i) => i.ajuste > 0).map((i) => ({ sku: i.sku, ajuste: i.ajuste })),
    conferencia: dados.posicaoAquecimentoFim && dados.posicaoConferencia ? conferirPosicao(dados, dados.posicaoAquecimentoFim, dados.posicaoConferencia) : null,
  };
}

export interface ConferenciaPosicao {
  de: Data;
  ate: Data;
  /** SKUs com posição do Omie nas DUAS datas e no mapa de SKUs. */
  total: number;
  /** Destes, quantos têm posição(de) + recebimentos − vendas(no escopo) de (de, ate] igual à posição(ate) (tolerância 1e-6). */
  batem: number;
  /** batem / total; null se total = 0. */
  pctBatem: number | null;
  divergentes: { sku: string; reconstruido: number; omie: number }[];
}

/**
 * Conferência da reconstrução (R31): parte da posição MEDIDA do Omie no fim do aquecimento (31/01) e aplica só os eventos
 * de 01/02 a 30/04 (vendas no escopo e recebimentos documentais), comparando com a posição medida em 30/04. Não altera nada;
 * mede a dedup física (revisão M1/M5) e a convenção de data do Omie.
 */
export function conferirPosicao(
  dados: DadosReconstrucao,
  inicio: Map<string, number>,
  fim: Map<string, number>,
  de: Data = JANELAS.aquecimentoFim,
  ate: Data = JANELAS.calibracaoFim,
): ConferenciaPosicao {
  const fluxo = new Map<string, number>();
  const soma = (sku: string, q: number) => fluxo.set(sku, (fluxo.get(sku) ?? 0) + q);
  for (const v of dados.vendas) if (v.noEscopo && v.data > de && v.data <= ate) soma(v.sku, -v.quantidade);
  for (const r of dados.recebimentos) if (r.data > de && r.data <= ate) soma(r.sku, r.quantidade);
  const divergentes: ConferenciaPosicao['divergentes'] = [];
  let total = 0;
  let batem = 0;
  for (const sku of [...dados.skus.keys()].sort()) {
    const a = inicio.get(sku);
    const b = fim.get(sku);
    if (a === undefined || b === undefined) continue;
    total++;
    const rec = a + (fluxo.get(sku) ?? 0);
    if (Math.abs(rec - b) <= 1e-6) batem++;
    else divergentes.push({ sku, reconstruido: rec, omie: b });
  }
  return { de, ate, total, batem, pctBatem: total === 0 ? null : batem / total, divergentes };
}
