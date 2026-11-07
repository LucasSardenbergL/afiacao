// Estatística do replay TSB (spec §5.8, §5.9 "Bootstrap"/"Precisão" e §6.1): bootstrap pareado por SOMAS semanais,
// Clopper-Pearson, meia largura Monte Carlo e a tabela de decisão (PASSA/FALHA/INCERTO → GO/NO-GO/INCONCLUSIVO).
//
// Bootstrap: blocos circulares de índices de semana; os MESMOS índices valem para as duas políticas e para todas as
// replicações (a estatística recebe um só `idx`). Cada reamostragem RECALCULA a estatística sobre as somas
// reamostradas — nunca média de razões. Aleatório = hash por chave (`aleatorio.ts#uniforme`), sem Math.random.
// Ausente ≠ zero: estatística null no ponto ou em qualquer reamostragem ⇒ limite null ⇒ critério INCERTO.
import { uniforme } from './aleatorio';
import { CENARIOS_FALTA, EXPOSICAO_MINIMA_LINHAS, GRADE_CUSTO, PISOS_SERVICO, PRECISAO } from './config';
import { quantilTipo7 } from './formulas';
import { custoLiquido, type GradeCusto } from './metricas';
import type { Celula, SomasSemanais } from './simulador';
import type {
  BlocoBootstrap,
  Classe,
  Evidencia,
  EvidenciaCapital,
  EvidenciaServico,
  Intervalo,
  IntervaloPorBloco,
  VereditoReplay,
} from './tipos';

/** Tolerância de não inferioridade contra F0 (spec §6, critério 2): queda ≤ 0,5 p.p. */
export const TOLERANCIA_NAO_INFERIORIDADE = 0.005;
/** Critério 3: redução pontual mínima e limite inferior mínimo. */
export const CAPITAL_REDUCAO_MINIMA = 0.1;
export const CAPITAL_LI_MINIMO = 0.05;
/** Quantis do bootstrap: limites UNILATERAIS de 95% (spec §6.1). */
const Q_INF = 0.05;
const Q_SUP = 0.95;
/** z bilateral de 95% para a meia largura MC. */
const Z_MC = 1.96;

export type Estado = 'PASSA' | 'FALHA' | 'INCERTO';
export interface Criterio {
  criterio: string;
  estado: Estado;
  motivo: string;
}

/** Estatística pareada sobre as replicações (`base[r]` ↔ `alt[r]`) restritas às semanas `idx` (com repetição). */
export type EstatisticaPareada = (
  base: readonly SomasSemanais[],
  alt: readonly SomasSemanais[],
  idx: readonly number[],
) => number | null;

// ── bootstrap ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Índices de uma reamostragem por blocos circulares: ceil(n/bloco) inícios uniformes em [0, n), cada um seguido de
 * `bloco` semanas contíguas módulo n; corta em n. Determinístico pela chave (n, bloco, r, j).
 */
export function indicesBlocosCirculares(n: number, bloco: BlocoBootstrap, r: number): number[] {
  if (!(Number.isInteger(n) && n > 0)) throw new Error('ESTATISTICA_SEM_SEMANAS');
  const idx: number[] = [];
  for (let j = 0; idx.length < n; j++) {
    const ini = Math.floor(uniforme('bootstrap-blocos', n, bloco, r, j) * n);
    for (let k = 0; k < bloco && idx.length < n; k++) idx.push((ini + k) % n);
  }
  return idx;
}

function conferirReps(base: readonly SomasSemanais[], alt: readonly SomasSemanais[]): number {
  if (base.length === 0 || base.length !== alt.length) throw new Error('ESTATISTICA_REPS_DESPAREADAS');
  const ref = base[0].semanas;
  const mesma = (s: SomasSemanais): boolean => s.semanas.length === ref.length && s.semanas.every((d, i) => d === ref[i]);
  if (!base.every(mesma) || !alt.every(mesma)) throw new Error('ESTATISTICA_REPS_DESPAREADAS');
  return ref.length;
}

function conferirIdx(n: number, idx: readonly number[]): void {
  for (const i of idx) if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`ESTATISTICA_SEMANA_FORA: ${i}`);
}

/**
 * Bootstrap pareado (spec §5.9): ponto = estatística na janela inteira; LI/LS = quantis tipo 7 de 5% e 95% das `nBoot`
 * reamostragens. `base`/`alt` = uma SomasSemanais por replicação, pareadas por índice. Os mesmos índices de semana
 * valem para as duas políticas e todas as replicações. Ponto null ⇒ tudo null; alguma reamostragem null ⇒ li/ls null.
 */
export function bootstrapPareado(
  base: readonly SomasSemanais[],
  alt: readonly SomasSemanais[],
  estat: EstatisticaPareada,
  bloco: BlocoBootstrap,
  nBoot: number = PRECISAO.bootstrapReamostragens,
): Intervalo {
  const n = conferirReps(base, alt);
  if (!(Number.isInteger(nBoot) && nBoot >= 2)) throw new Error('ESTATISTICA_NBOOT_INVALIDO');
  const ponto = estat(base, alt, Array.from({ length: n }, (_, i) => i));
  if (ponto === null) return { ponto: null, li: null, ls: null };
  const valores = new Float64Array(nBoot);
  for (let r = 0; r < nBoot; r++) {
    const v = estat(base, alt, indicesBlocosCirculares(n, bloco, r));
    if (v === null) return { ponto, li: null, ls: null };
    if (!Number.isFinite(v)) throw new Error('ESTATISTICA_VALOR_NAO_FINITO');
    valores[r] = v;
  }
  valores.sort();
  return { ponto, li: quantilTipo7(valores, Q_INF), ls: quantilTipo7(valores, Q_SUP) };
}

// ── estatísticas sobre as somas (todas recalculadas: Σ numerador ÷ Σ denominador, reps somadas) ──────────────

function fillAgregado(reps: readonly SomasSemanais[], c: Celula, idx: readonly number[]): number | null {
  let dem = 0;
  let integ = 0;
  for (const s of reps) {
    conferirIdx(s.semanas.length, idx);
    const cel = s.porCelula[c];
    for (const i of idx) {
      dem += cel.demandadas[i];
      integ += cel.integrais[i];
    }
  }
  return dem > 0 ? integ / dem : null;
}

function estoqueMedioAgregado(reps: readonly SomasSemanais[], idx: readonly number[]): number | null {
  let cmcDias = 0;
  let dias = 0;
  for (const s of reps) {
    conferirIdx(s.semanas.length, idx);
    for (const i of idx) {
      cmcDias += s.estoqueCmcDias[i];
      dias += s.diasCorridos[i];
    }
  }
  return dias > 0 ? cmcDias / dias : null;
}

/** Fill rate da ALTERNATIVA na célula, somando linhas de todas as replicações. */
export const estatFillRate =
  (c: Celula): EstatisticaPareada =>
  (_base, alt, idx) =>
    fillAgregado(alt, c, idx);

/** Δ fill rate (alt − base) na célula; null se qualquer lado sem linha. */
export const estatDeltaFillRate =
  (c: Celula): EstatisticaPareada =>
  (base, alt, idx) => {
    const fa = fillAgregado(alt, c, idx);
    const fb = fillAgregado(base, c, idx);
    return fa === null || fb === null ? null : fa - fb;
  };

/**
 * Redução relativa do estoque médio (1 − alt/base), ponderado pelos dias corridos; base sem estoque ⇒ null. Estoque sem
 * CMC em qualquer braço nas semanas `idx` ⇒ null (achado 10): a redução nunca sai do subtotal valorado.
 */
export const estatReducaoCapital: EstatisticaPareada = (base, alt, idx) => {
  for (const s of [...base, ...alt]) {
    conferirIdx(s.semanas.length, idx);
    for (const i of idx) if (s.estoqueNaoValoradoDias[i] > 0) return null;
  }
  const mb = estoqueMedioAgregado(base, idx);
  const ma = estoqueMedioAgregado(alt, idx);
  if (mb === null || ma === null || !(mb > 0)) return null;
  return 1 - ma / mb;
};

/**
 * Custo líquido (R$, positivo = alt vantajosa): média sobre as replicações de `custoLiquido(...).custo`. O terminal é
 * soma da ÚLTIMA semana (achado 12): só entra quando ela é sorteada. Alguma rep null (margem desconhecida, estoque sem
 * CMC) ⇒ null.
 */
export const estatCusto =
  (g: GradeCusto): EstatisticaPareada =>
  (base, alt, idx) => {
    let soma = 0;
    for (let r = 0; r < base.length; r++) {
      const c = custoLiquido(base[r], alt[r], g, idx).custo;
      if (c === null) return null;
      soma += c;
    }
    return soma / base.length;
  };

// ── Clopper-Pearson e precisão MC ─────────────────────────────────────────────────────────────────────────────

/** ln Γ(x), Lanczos (g = 7, 9 coeficientes), x > 0. */
function lnGama(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGama(1 - x);
  const xx = x - 1;
  let a = c[0];
  const t = xx + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Fração contínua da beta incompleta (Lentz modificado). */
function betaFc(a: number, b: number, x: number): number {
  const MIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < MIN) d = MIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < MIN) d = MIN;
    c = 1 + aa / c;
    if (Math.abs(c) < MIN) c = MIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < MIN) d = MIN;
    c = 1 + aa / c;
    if (Math.abs(c) < MIN) c = MIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) return h;
  }
  throw new Error('ESTATISTICA_BETA_NAO_CONVERGIU');
}

/** Beta incompleta regularizada I_x(a, b). */
function betaReg(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGama(a + b) - lnGama(a) - lnGama(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betaFc(a, b, x)) / a : 1 - (bt * betaFc(b, a, 1 - x)) / b;
}

/**
 * Limite inferior UNILATERAL exato (Clopper-Pearson) da proporção, ao nível `conf`: o p tal que
 * I_p(sucessos, n − sucessos + 1) = 1 − conf. `n` = contagem OBSERVADA de linhas da célula na janela (cada linha uma vez,
 * NUNCA a soma sobre as replicações, que inflaria a confiança); `sucessos` = atendidas nessa base (pode ser não inteiro:
 * média das replicações). 0 sucessos ⇒ 0.
 * Ex.: 100/100 a 95% = 0,05^(1/100) ≈ 97,05%.
 */
export function clopperPearsonInferior(sucessos: number, n: number, conf = 0.95): number {
  if (!(Number.isFinite(n) && n > 0 && Number.isFinite(sucessos) && sucessos >= 0 && sucessos <= n)) {
    throw new Error('CLOPPER_PEARSON_N_INVALIDO');
  }
  if (!(conf > 0 && conf < 1)) throw new Error('CLOPPER_PEARSON_CONF_INVALIDA');
  if (sucessos === 0) return 0;
  const alfa = 1 - conf;
  const b = n - sucessos + 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const meio = (lo + hi) / 2;
    if (betaReg(sucessos, b, meio) < alfa) lo = meio;
    else hi = meio;
  }
  return lo;
}

/** Meia largura do erro Monte Carlo: 1,96 × desvio amostral ÷ √n. Menos de 2 reps ⇒ Infinity (não estimável). */
export function meiaLarguraMC(valoresPorRep: readonly number[]): number {
  const n = valoresPorRep.length;
  if (valoresPorRep.some((v) => !Number.isFinite(v))) throw new Error('ESTATISTICA_VALOR_NAO_FINITO');
  if (n < 2) return Infinity;
  const m = valoresPorRep.reduce((t, v) => t + v, 0) / n;
  const s2 = valoresPorRep.reduce((t, v) => t + (v - m) ** 2, 0) / (n - 1);
  return (Z_MC * Math.sqrt(s2)) / Math.sqrt(n);
}

// ── tabela de decisão (spec §6.1) ─────────────────────────────────────────────────────────────────────────────

const CLASSES: readonly Classe[] = ['A', 'B', 'C'];
const CELULAS_SERVICO: readonly Celula[] = ['A', 'B', 'C', 'A_alt', 'B_alt', 'C_alt'];

/** LI = min(LI4, LI8), LS = max(LS4, LS8); qualquer null ⇒ null. O ponto é o mesmo nos dois (amostra inteira). */
function combinar(p: IntervaloPorBloco): Intervalo {
  const a = p[4];
  const b = p[8];
  if (a.ponto !== null && b.ponto !== null && Math.abs(a.ponto - b.ponto) > 1e-12) {
    throw new Error('ESTATISTICA_PONTO_DIVERGE_ENTRE_BLOCOS');
  }
  return {
    ponto: a.ponto ?? b.ponto,
    li: a.li === null || b.li === null ? null : Math.min(a.li, b.li),
    ls: a.ls === null || b.ls === null ? null : Math.max(a.ls, b.ls),
  };
}

const pct = (x: number | null, casas = 2): string => (x === null ? 'n/d' : `${(x * 100).toFixed(casas).replace('.', ',')}%`);
const limites = (iv: Intervalo): string => `ponto ${pct(iv.ponto)}, LI ${pct(iv.li)}, LS ${pct(iv.ls)}`;
const SEM_DADO = 'sem dado (null)';

function criterioPiso(nome: string, p: EvidenciaServico['pisos'][number]): Criterio {
  const piso = PISOS_SERVICO[p.classe];
  const iv = combinar(p.fill);
  const linhasOk =
    p.atendidas !== null && p.demandadas !== null && p.demandadas > 0 && p.atendidas >= 0 && p.atendidas <= p.demandadas;
  const cp = linhasOk ? clopperPearsonInferior(p.atendidas as number, p.demandadas as number) : null;
  const motivo = `${limites(iv)}, Clopper-Pearson ${pct(cp)}; piso ${pct(piso, 0)}`;
  if (iv.ls !== null && iv.ls < piso) return { criterio: nome, estado: 'FALHA', motivo };
  if (iv.li !== null && iv.li >= piso && cp !== null && cp >= piso) return { criterio: nome, estado: 'PASSA', motivo };
  return { criterio: nome, estado: 'INCERTO', motivo: iv.li === null || cp === null ? `${motivo}; ${SEM_DADO}` : motivo };
}

function criterioNaoInferioridade(nome: string, delta: IntervaloPorBloco): Criterio {
  const iv = combinar(delta);
  const motivo = `Δ ${limites(iv)}; tolerância −${pct(TOLERANCIA_NAO_INFERIORIDADE, 1)}`;
  if (iv.ls !== null && iv.ls < -TOLERANCIA_NAO_INFERIORIDADE) return { criterio: nome, estado: 'FALHA', motivo };
  if (iv.li !== null && iv.li >= -TOLERANCIA_NAO_INFERIORIDADE) return { criterio: nome, estado: 'PASSA', motivo };
  return { criterio: nome, estado: 'INCERTO', motivo: iv.li === null ? `${motivo}; ${SEM_DADO}` : motivo };
}

/** Critérios 1 e 2 (ou o serviço do 4, com `prefixo`), exigindo os dois extremos de falta, 3 classes e 6 células. */
function criteriosServico(servico: readonly EvidenciaServico[], prefixo: string): Criterio[] {
  const out: Criterio[] = [];
  for (const falta of CENARIOS_FALTA.servico) {
    if (!servico.some((s) => s.falta === falta)) {
      out.push({ criterio: `${prefixo}1-2 Serviço [${falta}]`, estado: 'INCERTO', motivo: 'cenário de falta sem evidência' });
    }
  }
  for (const s of servico) {
    for (const classe of CLASSES) {
      const nome = `${prefixo}1 Piso ${classe} [${s.falta}]`;
      const p = s.pisos.find((x) => x.classe === classe);
      out.push(p ? criterioPiso(nome, p) : { criterio: nome, estado: 'INCERTO', motivo: 'classe sem evidência' });
    }
    for (const celula of CELULAS_SERVICO) {
      const nome = `${prefixo}2 Não inferioridade ${celula} [${s.falta}]`;
      const ni = s.naoInferioridade.find((x) => x.celula === celula);
      out.push(ni ? criterioNaoInferioridade(nome, ni.delta) : { criterio: nome, estado: 'INCERTO', motivo: 'célula sem evidência' });
    }
  }
  return out;
}

/** Cenários obrigatórios do capital (R25: os mesmos da economia); cada um ausente vira uma linha INCERTO. */
function capitalAusente(capital: readonly EvidenciaCapital[], prefixo: string): Criterio[] {
  return CENARIOS_FALTA.economia
    .filter((falta) => !capital.some((c) => c.falta === falta))
    .map((falta) => ({ criterio: `${prefixo} [${falta}]`, estado: 'INCERTO' as const, motivo: 'cenário de falta sem evidência' }));
}

/** Achado 10: a fração do estoque (unidades × dias) sem CMC, quando houver; o capital vira INCERTO por falta de dado. */
function textoNaoValorado(c: EvidenciaCapital): string {
  const n = c.naoValorado;
  if (!n || ((n.f0 ?? 0) === 0 && (n.alt ?? 0) === 0)) return '';
  return `; estoque não valorado (sem CMC; unidades × dias): ${pct(n.f0)} (F0), ${pct(n.alt)} (cand.) — redução não mensurável`;
}

/** Critério 3 em cada cenário de `CENARIOS_FALTA.economia` (R25); qualquer FALHA ⇒ NO-GO, ausente ⇒ INCERTO. */
function criteriosCapital(capital: readonly EvidenciaCapital[]): Criterio[] {
  return [...capitalAusente(capital, '3 Capital'), ...capital.map((c): Criterio => {
    const nome = `3 Capital [${c.falta}]`;
    const iv = combinar(c.reducao);
    const motivo =
      `redução ${limites(iv)}; exige ponto ≥ ${pct(CAPITAL_REDUCAO_MINIMA, 0)} e LI ≥ ${pct(CAPITAL_LI_MINIMO, 0)}` + textoNaoValorado(c);
    if (iv.ls !== null && iv.ls < CAPITAL_REDUCAO_MINIMA) return { criterio: nome, estado: 'FALHA', motivo };
    if (iv.ponto !== null && iv.ponto >= CAPITAL_REDUCAO_MINIMA && iv.li !== null && iv.li >= CAPITAL_LI_MINIMO) {
      return { criterio: nome, estado: 'PASSA', motivo };
    }
    return { criterio: nome, estado: 'INCERTO', motivo };
  })];
}

function criteriosEstresse(ev: Evidencia['estresse']): Criterio[] {
  const out = criteriosServico(ev.servico, '4 Estresse ');
  out.push(...capitalAusente(ev.capital, '4 Estresse'));
  for (const c of ev.capital) {
    const nome = `4 Estresse [${c.falta}]`;
    const iv = combinar(c.reducao);
    const motivo = `redução ${limites(iv)}; exige LI > 0` + textoNaoValorado(c);
    if (iv.ls !== null && iv.ls <= 0) out.push({ criterio: nome, estado: 'FALHA', motivo });
    else if (iv.li !== null && iv.li > 0) out.push({ criterio: nome, estado: 'PASSA', motivo });
    else out.push({ criterio: nome, estado: 'INCERTO', motivo });
  }
  return out;
}

const rotuloGrade = (g: GradeCusto): string =>
  `taxa ${pct(g.taxa, 1)} emerg ${pct(g.emergencialPerc, 1)} atraso ${pct(g.atrasoPerc, 1)}`;
const fracao = (num: number, den: number | null): number | null => (den !== null && den > 0 ? num / den : null);

/**
 * Critério 5: cada célula fornecida é avaliada; exige, em cada cenário de `CENARIOS_FALTA.economia`, toda a grade na
 * taxa base (emergencial × atraso). As taxas de 20% e 30% são SÓ sensibilidade (R26): não são gate e a T9 não as passa;
 * se vierem, são avaliadas como as demais (código mantido). O motivo NÃO traz R$ absoluto (repo público): só o sinal exigido e o peso da
 * margem desconhecida (achado 11) em % das linhas e do valor demandados.
 */
function criteriosEconomia(economia: Evidencia['economia']): Criterio[] {
  const out: Criterio[] = [];
  for (const falta of CENARIOS_FALTA.economia) {
    const faltando: string[] = [];
    for (const emergencialPerc of GRADE_CUSTO.emergencial) {
      for (const atrasoPerc of GRADE_CUSTO.atrasoPorDia) {
        const ok = economia.some(
          (e) =>
            e.falta === falta &&
            e.grade.taxa === GRADE_CUSTO.taxaBase &&
            e.grade.emergencialPerc === emergencialPerc &&
            e.grade.atrasoPerc === atrasoPerc,
        );
        if (!ok) faltando.push(rotuloGrade({ taxa: GRADE_CUSTO.taxaBase, emergencialPerc, atrasoPerc }));
      }
    }
    if (faltando.length > 0) {
      out.push({ criterio: `5 Economia [${falta}]`, estado: 'INCERTO', motivo: `grade incompleta: ${faltando.length} célula(s) sem evidência` });
    }
  }
  for (const e of economia) {
    const nome = `5 Economia [${e.falta} ${rotuloGrade(e.grade)}]`;
    const iv = combinar(e.custo);
    const limite =
      `margem desconhecida (cancelada sem CMC; achado 11): ${pct(fracao(e.linhasMargemDesconhecida, e.linhasDemandadas))} das linhas, ` +
      `${pct(fracao(e.valorMargemDesconhecida, e.valorDemandado))} do valor`;
    if (iv.ls !== null && iv.ls < 0) out.push({ criterio: nome, estado: 'FALHA', motivo: `LS(custo líquido) < 0; ${limite}` });
    else if (iv.li !== null && iv.li > 0) out.push({ criterio: nome, estado: 'PASSA', motivo: `LI(custo líquido) > 0; ${limite}` });
    else {
      const m = iv.li === null ? SEM_DADO : 'LI ≤ 0 ≤ LS';
      out.push({ criterio: nome, estado: 'INCERTO', motivo: `${m}; ${limite}` });
    }
  }
  return out;
}

function criteriosExposicao(exposicao: Evidencia['exposicao']): Criterio[] {
  return CELULAS_SERVICO.map((celula) => {
    const nome = `Exposição ${celula}`;
    const linhas = exposicao.find((x) => x.celula === celula)?.linhas ?? null;
    if (linhas === null) return { criterio: nome, estado: 'INCERTO', motivo: SEM_DADO };
    const motivo = `${linhas} linhas; mínimo ${EXPOSICAO_MINIMA_LINHAS}`;
    return { criterio: nome, estado: linhas >= EXPOSICAO_MINIMA_LINHAS ? 'PASSA' : 'INCERTO', motivo };
  });
}

function criterioPrecisao(p: Evidencia['precisao']): Criterio {
  const nome = 'Precisão';
  const motivo =
    `${p.replicacoes} replicações (teto ${p.teto}); meia largura serviço ${pct(p.meiaLarguraServico, 3)} ` +
    `(alvo ${pct(p.alvoServico, 3)}), estoque ${pct(p.meiaLarguraEstoque, 3)} (alvo ${pct(p.alvoEstoque, 3)})`;
  if (p.meiaLarguraServico === null || p.meiaLarguraEstoque === null) {
    return { criterio: nome, estado: 'INCERTO', motivo: `${motivo}; ${SEM_DADO}` };
  }
  if (p.meiaLarguraServico <= p.alvoServico && p.meiaLarguraEstoque <= p.alvoEstoque) {
    return { criterio: nome, estado: 'PASSA', motivo };
  }
  const porque = p.replicacoes >= p.teto ? 'teto atingido sem precisão' : 'precisão não atingida abaixo do teto (rodada incompleta)';
  return { criterio: nome, estado: 'INCERTO', motivo: `${motivo}; ${porque}` };
}

function criterioEstadoInicial(estados: Evidencia['estadosIniciais']): Criterio {
  const nome = 'Estado inicial';
  if (estados === null || estados.length < 2) {
    return { criterio: nome, estado: 'INCERTO', motivo: 'menos de 2 estados iniciais avaliados' };
  }
  const motivo = estados.map((e) => `${e.rotulo}=${e.veredito ?? 'n/d'}`).join(', ');
  const v0 = estados[0].veredito;
  const iguais = v0 !== null && estados.every((e) => e.veredito === v0);
  return { criterio: nome, estado: iguais ? 'PASSA' : 'INCERTO', motivo };
}

/**
 * Tabela da spec §6.1, linha por linha, com LI = min(LI4, LI8) e LS = max(LS4, LS8). Uma linha de saída por item
 * avaliado (classe × cenário, célula da grade...). Evidência ausente vira INCERTO, nunca PASSA.
 * Para a linha "Estado inicial", o chamador calcula o veredito de cada estado com `estadosIniciais: null` e descarta a
 * linha "Estado inicial" (é a única que lê os outros vereditos).
 */
export function avaliarCriterios(ev: Evidencia): Criterio[] {
  return [
    ...criteriosServico(ev.servico, ''),
    ...criteriosCapital(ev.capital),
    ...criteriosEstresse(ev.estresse),
    ...criteriosEconomia(ev.economia),
    ...criteriosExposicao(ev.exposicao),
    criterioPrecisao(ev.precisao),
    criterioEstadoInicial(ev.estadosIniciais),
  ];
}

/**
 * Precedência da spec §6.1: alguma FALHA ⇒ NO-GO (motivos = as FALHAs); senão algum INCERTO, `null` ou lista vazia ⇒
 * INCONCLUSIVO (motivos = os incertos); senão GO.
 */
export function veredito(criterios: readonly { criterio: string; estado: Estado | null; motivo: string }[]): {
  veredito: VereditoReplay;
  motivos: string[];
} {
  const fmt = (c: { criterio: string; motivo: string }): string => `${c.criterio}: ${c.motivo}`;
  const falhas = criterios.filter((c) => c.estado === 'FALHA');
  if (falhas.length > 0) return { veredito: 'NO-GO', motivos: falhas.map(fmt) };
  if (criterios.length === 0) return { veredito: 'INCONCLUSIVO', motivos: ['nenhum critério avaliado'] };
  const incertos = criterios.filter((c) => c.estado !== 'PASSA');
  if (incertos.length > 0) return { veredito: 'INCONCLUSIVO', motivos: incertos.map(fmt) };
  return { veredito: 'GO', motivos: [] };
}

