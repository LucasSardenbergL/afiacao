// Decomposição D/L/U da falha dos SUAVES de A (spec 2026-11-09 §2.2; §4.4 item 7: diagnóstico do relatório do pacote).
// Porte do `diag-suaves-a-v2.ts` da sessão de desenho (o que o Codex de desenho reproduziu: Shapley D 1,67 · L 2,31 · U 3,46
// nos dados de 09/11). Contrafactuais sobre o PRÓPRIO simulador, na calibração (01/02–30/04): troca só os params F0 dos
// suaves; o resto do mapa é o F0 oficial. Os três fatores trocam um insumo do F0 por uma REFERÊNCIA RETROSPECTIVA — são
// diagnósticos, não estimativas que o motor teria no dia:
//   D: demanda média de 90 d → média CENTRADA [d−45, d+45), TRUNCADA em 30/04 (não lê nada da avaliação);
//   L: LT do parâmetro → LT esperado do sorteio no SKU-dia (média/desvio de max(1, lt) em ≥ 200 réplicas INDEPENDENTES das
//      medidas: reps 1000+);
//   U: o termo médio D_corrido × LT_du vira D_corrido × LT_du × 7/5; o σ (σd e σLT) fica como está.
// Gravação simplificada (aplica toda sugestão OK, segura a última, cold start (1, 2) antes): o CONTROLE da mesma invocação
// (D0L0U0 recalculado × oficial) mede o quanto essa simplificação desvia — o relatório mostra o desvio, nunca o esconde.
import { amostraDoSorteio, itensLtPermitidos, ltRealizado } from './aleatorio';
import { baseDaCalibracao, estoqueComparavel, mediaSomas, REPS_CALIBRACAO, somarSomas, suavesDaCoorte } from './calibracao';
import { classeEfetiva } from './classe';
import { F0, JANELAS } from './config';
import { diagnosticoF0, type DiagnosticoF0, type ParamsDia } from './formulas';
import { coorte } from './parados';
import { simular, type SomasSemanais } from './simulador';
import type { Classe, Dados, Data } from './tipos';

const U = 7 / 5;
const teto9 = (x: number) => Math.ceil(Math.round(x * 1e9) / 1e9);
const addDiasUtc = (d: Data, n: number): Data => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export interface CombinacaoDLU {
  D: 0 | 1;
  L: 0 | 1;
  U: 0 | 1;
  /** Fill das linhas de A dos suaves (1 − falhas/linhas), média das reps. */
  fillSuavesA: number;
  /** Ī_combinação / Ī_oficial − 1 na coorte; null = estoque não valorado. */
  deltaEstoque: number | null;
}
export interface DecomposicaoDLU {
  reps: number;
  linhasSuavesA: number;
  /** Fill dos suaves de A no F0 oficial e no recálculo D0L0U0 (controle da gravação simplificada). */
  controle: { oficial: number; recalculo: number };
  combinacoes: CombinacaoDLU[];
  /** Shapley de 3 fatores (fração de fill, não p.p.) e o que falta até 100% com os três ligados. */
  shapley: { D: number; L: number; U: number };
  residual: number;
}

/** Shapley de 3 fatores sobre f(D, L, U) — média das contribuições marginais nas 6 ordens. Exportada para o oráculo. */
export function shapley3(f: (d: 0 | 1, l: 0 | 1, u: 0 | 1) => number): { D: number; L: number; U: number } {
  const fat = ['D', 'L', 'U'] as const;
  const out = { D: 0, L: 0, U: 0 };
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const p of perms) {
    const on: (0 | 1)[] = [0, 0, 0];
    for (const i of p) {
      const antes = f(on[0], on[1], on[2]);
      on[i] = 1;
      out[fat[i]] += (f(on[0], on[1], on[2]) - antes) / 6;
    }
  }
  return out;
}

/** D/L/U não medível (ausente ≠ zero): sem linhas de A dos suaves na calibração não há fill a decompor. */
export interface DLUIndisponivel {
  indisponivel: string;
}

export function decomporDLU(dados: Dados, reps = REPS_CALIBRACAO): DecomposicaoDLU | DLUIndisponivel {
  const [CI, CF] = [JANELAS.calibracaoIni, JANELAS.calibracaoFim];
  const c = coorte(dados);
  const suaves = suavesDaCoorte(c);
  const f0Mapa = baseDaCalibracao(dados).f0Mapa;
  const memoCl = new Map<Data, Map<string, Classe>>();
  const classeDia = (d: Data) => {
    let m = memoCl.get(d);
    if (!m) memoCl.set(d, (m = classeEfetiva(dados, d)));
    return m;
  };
  // linhas medidas de A na calibração (classe efetiva do dia, como o simulador); as dos suaves são o denominador
  const linhasA = new Map<string, string>();
  for (const v of dados.vendas) {
    if (!v.noEscopo || !(v.quantidade > 0) || v.data < CI || v.data > CF || !c.populacao.has(v.sku)) continue;
    if ((classeDia(v.data).get(v.sku) ?? 'C') === 'A') linhasA.set(v.linhaId, v.sku);
  }
  const linhasSuavesA = [...linhasA.values()].filter((s) => suaves.has(s)).length;
  // classe A sem linha dos suaves (o caso INCONCLUSIVO da §4.2(5)): o diagnóstico vira n/d, nunca derruba a rodada
  if (linhasSuavesA === 0) return { indisponivel: 'DLU_SEM_LINHAS_A_DOS_SUAVES' };
  const vendaDia = new Map<string, number>();
  for (const v of dados.vendas) if (v.noEscopo && v.quantidade > 0) vendaDia.set(`${v.sku}|${v.data}`, (vendaDia.get(`${v.sku}|${v.data}`) ?? 0) + v.quantidade);
  // D: média centrada de 90 dias corridos, truncada em 30/04 (o divisor é o nº de dias lidos)
  const demCentrada = (sku: string, d: Data): number => {
    let t = 0;
    let n = 0;
    for (let i = -45; i < 45; i++) {
      const x = addDiasUtc(d, i);
      if (x > CF) break;
      t += vendaDia.get(`${sku}|${x}`) ?? 0;
      n++;
    }
    return n > 0 ? t / n : 0;
  };
  // L: momentos do sorteio em réplicas INDEPENDENTES das medidas (1000+), no mínimo 200
  const itensPre = itensLtPermitidos(amostraDoSorteio(dados.itensLT), true, dados.dataExtracao);
  const memoLt = new Map<string, { m: number; s: number }>();
  const ltSorteio = (sku: string, d: Data) => {
    const k = `${sku}|${d}`;
    let r = memoLt.get(k);
    if (!r) {
      const xs: number[] = [];
      for (let rep = 1000; rep < 1000 + Math.max(reps, 200); rep++) xs.push(Math.max(1, ltRealizado(rep, d, sku, 'empirico', itensPre)));
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      const s = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
      memoLt.set(k, (r = { m, s }));
    }
    return r;
  };
  const diag = new Map<string, DiagnosticoF0>();
  const diagDe = (sku: string, d: Data) => {
    const k = `${sku}|${d}`;
    let g = diag.get(k);
    if (!g) diag.set(k, (g = diagnosticoF0(dados, sku, d, { calibracao: true })));
    return g;
  };
  const chaves = [...f0Mapa.keys()].sort((a, b) => {
    const da = a.slice(a.indexOf('|') + 1);
    const db = b.slice(b.indexOf('|') + 1);
    return da < db ? -1 : da > db ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
  const mapaVariante = (D: 0 | 1, L: 0 | 1, Uu: 0 | 1): Map<string, ParamsDia> => {
    const out = new Map<string, ParamsDia>();
    const estado = new Map<string, { pp: number; max: number }>();
    for (const k of chaves) {
      const p = f0Mapa.get(k)!;
      const sku = k.slice(0, k.indexOf('|'));
      const d = k.slice(k.indexOf('|') + 1);
      if (!suaves.has(sku) || p.tipo !== 'F0') {
        out.set(k, p);
        continue;
      }
      const g = diagDe(sku, d);
      const s = dados.skus.get(sku)!;
      if (g.status === 'OK' && g.demanda !== null && g.lt !== null && g.precoEoq && g.z !== null) {
        const dem = D ? demCentrada(sku, d) : g.demanda;
        const lt = L ? ltSorteio(sku, d) : { m: g.lt, s: g.sigmaLt };
        const sd = g.sigmaD ?? g.demanda * 0.5;
        const sLt = lt.s ?? g.sigmaLt;
        if (sLt === null) throw new Error(`DLU_SIGMA_LT_AUSENTE:${k}`); // ausente ≠ zero
        const sig = Math.sqrt(lt.m * sd ** 2 + dem ** 2 * sLt ** 2);
        const ss = teto9(g.z * sig);
        const ppc = teto9(dem * lt.m * (Uu ? U : 1) + g.z * sig);
        const cm = s.f0.custoCapitalPerc / 100;
        const qc = g.precoEoq > 0 && cm > 0 && dem > 0 ? teto9(Math.sqrt((2 * (dem * F0.diasAnoEoq) * s.f0.custoPedido) / (cm * g.precoEoq))) : 1;
        const pp = Math.max(ppc, Math.max(ss, g.minimoOperacional ?? 0) + 1);
        estado.set(sku, { pp, max: pp + Math.max(qc, 1) });
      }
      const e = estado.get(sku) ?? { pp: 1, max: 2 };
      out.set(k, { ...p, pp: e.pp, max: e.max });
    }
    return out;
  };
  const rodar = (params: Map<string, ParamsDia>): { fill: number; estoque: number | null; demA: number } => {
    let acc: SomasSemanais | null = null;
    let falhas = 0;
    for (let rep = 0; rep < reps; rep++) {
      const s = simular({ formula: 'F0', params, rep, lt: 'empirico', falta: 'espera', inicial: 'reconstruido', janela: [CI, CF], dados, rastro: true });
      for (const f of s.desfechos ?? []) {
        const sku = linhasA.get(f.linhaId);
        if (sku !== undefined && suaves.has(sku)) falhas++;
      }
      s.desfechos = undefined;
      s.pedidos = undefined;
      acc = somarSomas(acc, s);
    }
    const m = mediaSomas(acc!, reps);
    return { fill: 1 - falhas / reps / linhasSuavesA, estoque: estoqueComparavel(m), demA: m.porCelula.A.demandadas.reduce((a, b) => a + b, 0) };
  };
  const oficial = rodar(f0Mapa);
  // a contagem de linhas A daqui tem de ser a da célula do simulador (senão o denominador não é o dele)
  if (Math.abs(oficial.demA - linhasA.size) > 1e-6) throw new Error(`DLU_LINHAS_A_DIVERGEM:${linhasA.size}≠${oficial.demA}`);
  const combinacoes: CombinacaoDLU[] = [];
  for (const D of [0, 1] as const) {
    for (const L of [0, 1] as const) {
      for (const Uu of [0, 1] as const) {
        const r = rodar(mapaVariante(D, L, Uu));
        const delta = r.estoque === null || oficial.estoque === null || !(oficial.estoque > 0) ? null : r.estoque / oficial.estoque - 1;
        combinacoes.push({ D, L, U: Uu, fillSuavesA: r.fill, deltaEstoque: delta });
      }
    }
  }
  const f = (d: 0 | 1, l: 0 | 1, u: 0 | 1) => combinacoes.find((x) => x.D === d && x.L === l && x.U === u)!.fillSuavesA;
  return {
    reps,
    linhasSuavesA,
    controle: { oficial: oficial.fill, recalculo: f(0, 0, 0) },
    combinacoes,
    shapley: shapley3(f),
    residual: 1 - f(1, 1, 1),
  };
}
