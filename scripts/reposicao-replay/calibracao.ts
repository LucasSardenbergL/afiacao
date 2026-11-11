// Calibração do replay TSB (spec §5.3 "Parâmetros", §5.9 "Calibração") e a escolha da candidata.
//
// Contexto fixo da calibração: janela 2026-02-01→2026-04-30, `calibracao = true` (LT só de documentos com t4 <= fim da
// calibração), LT `empirico`, falta `espera`, estado inicial `reconstruido` e 50 replicações (0..49). Nada da avaliação
// entra: os parâmetros são pré-computados com dados < d e o estado inicial usa só eventos até o fim da calibração.
//
// Alvo por classe = max(piso da classe, fill rate do F0 na calibração − 0,25 p.p.) (spec §5.3). A busca usa a grade fixa
// de quantis (o serviço NÃO é monotônico no nível: múltiplo de embalagem × LT do dia), descida por coordenada (uma classe
// por vez, duas rodadas) e valida as três classes juntas no trio final. Escolhe o trio de menor estoque médio que atinge
// o alvo; desempate pelo menor quantil. Nada atinge ⇒ inviável.
//
// DECISÕES DOCUMENTADAS (Task 9):
//  · Só os SKUs `alterados` (intermitentes/lumpy no corte) trocam de fórmula; os suaves/erráticos ficam com o F0 em todas
//    as variantes (spec §5.3 "Classificação") — `mapaMisto`.
//  · O fill rate da classe é o da célula da classe (A/B/C: todos os SKUs da classe, com os suaves no F0), como a spec
//    define o alvo; as células `*_alt` não entram na calibração (só são medidas na avaliação, critério 2).
//  · Classe sem linha na calibração (fill do F0 null) é "não observável": fica no quantil mais alto da grade (conservador
//    para o serviço) e o veredito vira INCONCLUSIVO (spec §5.9).
//  · Estoque médio = estoque físico médio a CMC da coorte inteira (célula total), ponderado por dias corridos, somando as
//    replicações.
import { CENARIOS_FALTA, FOLGA_ALVO_PP, GRADE_QUANTIS, JANELAS, PISOS_SERVICO, TSB } from './config';
import { chavePerfil, GRADE_Z_A, PERFIL_P0, preComputarComOrigem, type Formula, type ParamsDia, type ParamsFormula, type PerfilF0 } from './formulas';
import { coorte } from './parados';
import { CELULAS, simular, type Celula, type SomasSemanais } from './simulador';
import type { Classe, Dados, Data } from './tipos';

export const CLASSES: readonly Classe[] = ['A', 'B', 'C'];
export const REPS_CALIBRACAO = 50;
/** Janelas do F3 (du) candidatas na calibração (ParamsFormula.janelaDias). */
export const JANELAS_F3 = [60, 90, 180] as const;
/** Ordem de simplicidade (spec §5.9): F1 < F3 < F2. */
export const ORDEM_SIMPLICIDADE: readonly Formula[] = ['F1', 'F3', 'F2'];
/** Uma fórmula mais simples fica com a vaga se o estoque dela estiver a ≤ 1 p.p. de capital (do F0) da melhor. */
export const TOLERANCIA_SIMPLICIDADE_PP = 0.01;
const JANELA_CALIBRACAO: [Data, Data] = [JANELAS.calibracaoIni, JANELAS.calibracaoFim];

// ── agregação de replicações (somas; o bootstrap e a calibração usam a MÉDIA, que preserva todas as razões) ─────────

/** Acumula `s` em `acc` (mesmas semanas). Margem semanal null (só canceladas sem cmc) entra como 0 conhecido. */
export function somarSomas(acc: SomasSemanais | null, s: SomasSemanais): SomasSemanais {
  if (acc === null) {
    return {
      ...structuredClone({ ...s, pedidos: undefined, desfechos: undefined }),
      cancelada: { valor: [...s.cancelada.valor], margem: s.cancelada.margem.map((m) => m ?? 0) },
    };
  }
  if (acc.semanas.length !== s.semanas.length || acc.semanas.some((d, i) => d !== s.semanas[i])) throw new Error('AGREGACAO_SEMANAS_DIFERENTES');
  const mais = (a: number[], b: readonly number[]) => {
    for (let i = 0; i < a.length; i++) a[i] += b[i];
  };
  for (const c of CELULAS) {
    const a = acc.porCelula[c];
    const b = s.porCelula[c];
    mais(a.demandadas, b.demandadas);
    mais(a.integrais, b.integrais);
    mais(a.unidDem, b.unidDem);
    mais(a.unidAt, b.unidAt);
    mais(a.valorDem, b.valorDem);
    mais(a.valorAt, b.valorAt);
  }
  mais(acc.estoqueCmcDias, s.estoqueCmcDias);
  mais(acc.estoqueNaoValoradoDias, s.estoqueNaoValoradoDias);
  mais(acc.estoqueUnidadesDias, s.estoqueUnidadesDias);
  mais(acc.estoqueCmcDiasGrupos, s.estoqueCmcDiasGrupos);
  mais(acc.estoqueUnidadesDiasCompraReal, s.estoqueUnidadesDiasCompraReal);
  mais(acc.estoqueUnidadesDiasCmcOmie, s.estoqueUnidadesDiasCmcOmie);
  mais(acc.entregue.imediata, s.entregue.imediata);
  mais(acc.entregue.tardia, s.entregue.tardia);
  mais(acc.entregue.emergencial, s.entregue.emergencial);
  mais(acc.cancelada.valor, s.cancelada.valor);
  for (let i = 0; i < acc.cancelada.margem.length; i++) acc.cancelada.margem[i] = (acc.cancelada.margem[i] ?? 0) + (s.cancelada.margem[i] ?? 0);
  mais(acc.canceladaSemCmc.linhas, s.canceladaSemCmc.linhas);
  mais(acc.canceladaSemCmc.valor, s.canceladaSemCmc.valor);
  mais(acc.valorDiasAtraso, s.valorDiasAtraso);
  acc.terminal.estoqueCmc += s.terminal.estoqueCmc;
  acc.terminal.abertasCmc += s.terminal.abertasCmc;
  acc.terminal.backlogValor += s.terminal.backlogValor;
  acc.terminal.backlogDiasAtraso += s.terminal.backlogDiasAtraso;
  acc.balanco.inicial += s.balanco.inicial;
  acc.balanco.recebido += s.balanco.recebido;
  acc.balanco.entregue += s.balanco.entregue;
  acc.balanco.final += s.balanco.final;
  for (const k of ['linhas', 'integrais', 'valorDem', 'valorAt'] as const) acc.servicoExtras[k] += s.servicoExtras[k];
  if (acc.herdadas && s.herdadas) {
    for (const k of ['abertura', 'entregue', 'terminal'] as const) {
      acc.herdadas[k].unidades += s.herdadas[k].unidades;
      acc.herdadas[k].valor += s.herdadas[k].valor;
    }
  } else if (acc.herdadas || s.herdadas) throw new Error('AGREGACAO_HERDADAS_INCOERENTES');
  // diasCorridos é do calendário (igual em todas as reps): NÃO soma.
  return acc;
}

/**
 * Média de `n` replicações já somadas: divide tudo por n, menos `diasCorridos` (calendário). As razões (fill rate, estoque
 * médio) e o custo líquido da média são exatamente a média/razão agregada das replicações; `demandadas` volta à contagem
 * OBSERVADA de linhas (é igual em todas as reps).
 */
export function mediaSomas(soma: SomasSemanais, n: number): SomasSemanais {
  if (!(Number.isInteger(n) && n > 0)) throw new Error('AGREGACAO_N_INVALIDO');
  const m = structuredClone(soma);
  const div = (a: (number | null)[]) => {
    for (let i = 0; i < a.length; i++) a[i] = (a[i] ?? 0) / n;
  };
  for (const c of CELULAS) {
    const x = m.porCelula[c];
    div(x.demandadas);
    div(x.integrais);
    div(x.unidDem);
    div(x.unidAt);
    div(x.valorDem);
    div(x.valorAt);
  }
  div(m.estoqueCmcDias);
  div(m.estoqueNaoValoradoDias);
  div(m.estoqueUnidadesDias);
  div(m.estoqueCmcDiasGrupos);
  div(m.estoqueUnidadesDiasCompraReal);
  div(m.estoqueUnidadesDiasCmcOmie);
  div(m.entregue.imediata);
  div(m.entregue.tardia);
  div(m.entregue.emergencial);
  div(m.cancelada.valor);
  div(m.cancelada.margem);
  div(m.canceladaSemCmc.linhas);
  div(m.canceladaSemCmc.valor);
  div(m.valorDiasAtraso);
  for (const k of ['estoqueCmc', 'abertasCmc', 'backlogValor', 'backlogDiasAtraso'] as const) m.terminal[k] /= n;
  for (const k of ['inicial', 'recebido', 'entregue', 'final'] as const) m.balanco[k] /= n;
  for (const k of ['linhas', 'integrais', 'valorDem', 'valorAt'] as const) m.servicoExtras[k] /= n;
  if (m.herdadas) {
    for (const k of ['abertura', 'entregue', 'terminal'] as const) {
      m.herdadas[k].unidades /= n;
      m.herdadas[k].valor /= n;
    }
  }
  return m;
}

const soma = (v: readonly number[]) => v.reduce((t, x) => t + x, 0);
/** Fill rate (Σ integrais ÷ Σ demandadas) da célula; null sem linha. */
export function fillDaCelula(s: SomasSemanais, c: Celula): number | null {
  const dem = soma(s.porCelula[c].demandadas);
  return dem > 0 ? soma(s.porCelula[c].integrais) / dem : null;
}
/** Estoque médio a CMC ponderado por dias corridos (já é por rep se `s` for média). */
export function estoqueDaJanela(s: SomasSemanais): number {
  const dias = soma(s.diasCorridos);
  if (!(dias > 0)) throw new Error('CALIBRACAO_SEM_DIAS');
  return soma(s.estoqueCmcDias) / dias;
}

/**
 * I2 (achado 10 na calibração): o estoque médio só é COMPARÁVEL se todo o estoque da janela é valorado. Com estoque sem
 * CMC (unidades × dias > 0) ⇒ null: a redução do subtotal valorado nunca entra em escolha, fronteira nem precisão.
 */
export function estoqueComparavel(s: SomasSemanais): number | null {
  return soma(s.estoqueNaoValoradoDias) > 0 ? null : estoqueDaJanela(s);
}

/** Redução relativa 1 − alt/base; null se algum lado não é comparável (I2) ou a base não tem estoque. */
export function reducaoRelativa(alt: number | null, base: number | null): number | null {
  return alt === null || base === null || !(base > 0) ? null : 1 - alt / base;
}

// ── mapa de parâmetros: Fn só nos alterados ───────────────────────────────────────────────────────────────────────

/**
 * Parâmetros da população: `fn` nos SKUs `alterados`, F0 nos demais (spec §5.3: os suaves ficam na fórmula atual).
 * `fn` null = o próprio F0. Só as chaves `${sku}|${d}` dos SKUs de `populacao`.
 */
export function mapaMisto(
  f0: Map<string, ParamsDia>,
  fn: Map<string, ParamsDia> | null,
  populacao: ReadonlySet<string>,
  alterados: ReadonlySet<string>,
): Map<string, ParamsDia> {
  const out = new Map<string, ParamsDia>();
  for (const [k, p] of f0) {
    const sku = k.slice(0, k.indexOf('|'));
    if (!populacao.has(sku)) continue;
    if (fn !== null && alterados.has(sku)) {
      const q = fn.get(k);
      if (q === undefined) throw new Error(`MAPA_MISTO_SEM_PARAMETRO:${k}`);
      out.set(k, q);
    } else out.set(k, p);
  }
  return out;
}

// ── alvo e busca na grade ────────────────────────────────────────────────────────────────────────────────────────

/** Alvo da classe = max(piso, fill do F0 na calibração − 0,25 p.p.); F0 sem linha ⇒ null (não observável). */
export function alvoDaClasse(classe: Classe, fillF0: number | null): number | null {
  if (fillF0 === null) return null;
  return Math.max(PISOS_SERVICO[classe], fillF0 - FOLGA_ALVO_PP);
}

export type Trio = Record<Classe, number>;
export interface AvaliacaoTrio {
  fill: Record<Classe, number | null>;
  /** Estoque médio comparável; null = há estoque sem CMC na janela (I2: o trio não é ordenável por capital). */
  estoque: number | null;
}
export interface ResultadoBusca {
  quantil: Trio;
  inviavel: boolean;
  avaliacao: AvaliacaoTrio;
  /** Classes sem linha na calibração (alvo null): ficam no quantil mais alto e geram INCONCLUSIVO. */
  naoObservaveis: Classe[];
  /** Trios distintos avaliados. */
  avaliacoes: number;
  /**
   * I2 + N4: há trio que atinge o alvo, mas o caminho teve estoque sem preço — nenhuma escolha por capital (nem por
   * subtotal); a fórmula fica INDETERMINADA, nunca inviável por isso.
   */
  capitalIndeterminado: boolean;
}

const QMAX = GRADE_QUANTIS[GRADE_QUANTIS.length - 1];
/** Ordem lexicográfica (A, B, C) dos quantis: negativo = `a` menor. */
export function compararTrio(a: Trio, b: Trio): number {
  return a.A - b.A || a.B - b.B || a.C - b.C;
}
const atinge = (a: AvaliacaoTrio, alvo: Record<Classe, number | null>, c: Classe): boolean => {
  const meta = alvo[c];
  if (meta === null) return true; // não observável: sem restrição (fica no quantil mais alto)
  const f = a.fill[c];
  return f !== null && f >= meta - 1e-12;
};

/**
 * Descida por coordenada na grade fixa (2 rodadas, ordem A, B, C) e validação conjunta. Em cada classe, entre os quantis
 * da grade que atingem o alvo DELA (com as outras fixas), fica o de menor estoque; empate → menor quantil. Nenhum atinge
 * ⇒ mantém o atual. Começa no quantil mais alto em todas. Ao fim, a escolha é, entre TODOS os trios avaliados que atingem
 * o alvo nas três classes (validação conjunta), o de menor estoque; empate → menor quantil (lexicográfico A, B, C).
 * Inviável só se NENHUM trio avaliado atinge (spec §5.9: "nenhum ponto atinge"; review I-2).
 *
 * N4 (capital desconhecido): um estoque null NUNCA interrompe a busca. Na varredura de uma classe, se algum quantil que
 * atinge o alvo dela tem estoque null, a ordenação por capital é impossível: a classe fica onde está (não se escolhe por
 * subtotal) e a busca segue, visitando todos os pontos do caminho. No fim (R50): qualquer estoque null no caminho ⇒
 * INDETERMINADA (`capitalIndeterminado`, nunca inviável), haja ou não trio que atinja — o caminho dependeu do capital;
 * inviável só com o caminho inteiro valorado e nenhum trio que atinja.
 */
export function buscarTrio(avaliar: (q: Trio) => AvaliacaoTrio, alvo: Record<Classe, number | null>): ResultadoBusca {
  const memo = new Map<string, AvaliacaoTrio>();
  const aval = (q: Trio): AvaliacaoTrio => {
    const k = `${q.A}|${q.B}|${q.C}`;
    let a = memo.get(k);
    if (!a) memo.set(k, (a = avaliar(q)));
    return a;
  };
  const naoObservaveis = CLASSES.filter((c) => alvo[c] === null);
  const trio: Trio = { A: QMAX, B: QMAX, C: QMAX };
  let semCapital = aval(trio).estoque === null;
  for (let rodada = 0; rodada < 2; rodada++) {
    for (const c of CLASSES) {
      if (alvo[c] === null) continue;
      let melhor: { q: number; estoque: number } | null = null;
      let indeterminada = false;
      for (const q of GRADE_QUANTIS) {
        const a = aval({ ...trio, [c]: q });
        if (a.estoque === null) semCapital = true;
        if (!atinge(a, alvo, c)) continue;
        if (a.estoque === null) {
          indeterminada = true; // atinge, mas sem capital: não se ordena por subtotal
          continue;
        }
        if (melhor === null || a.estoque < melhor.estoque - 1e-9) melhor = { q, estoque: a.estoque }; // grade crescente: empate fica no menor
      }
      if (melhor !== null && !indeterminada) trio[c] = melhor.q;
    }
  }
  aval(trio);
  const atingem = [...memo].filter(([, a]) => CLASSES.every((c) => atinge(a, alvo, c)));
  if (semCapital || atingem.some(([, a]) => a.estoque === null)) {
    // N4 + R50: o caminho teve capital desconhecido. Ele DEPENDE do capital (a classe não se move onde o estoque é null),
    // então nem a escolha nem a inviabilidade estão provadas: INDETERMINADA, nunca INVIAVEL — haja ou não trio que atinja.
    const [k, a] = atingem[0] ?? [`${trio.A}|${trio.B}|${trio.C}`, memo.get(`${trio.A}|${trio.B}|${trio.C}`)!];
    const [A, B, C] = k.split('|').map(Number);
    return { quantil: { A, B, C }, inviavel: false, avaliacao: { ...a, estoque: null }, naoObservaveis, avaliacoes: memo.size, capitalIndeterminado: true };
  }
  if (atingem.length === 0) return { quantil: { ...trio }, inviavel: true, avaliacao: memo.get(`${trio.A}|${trio.B}|${trio.C}`)!, naoObservaveis, avaliacoes: memo.size, capitalIndeterminado: false };
  let escolhido: { q: Trio; a: AvaliacaoTrio; e: number } | null = null;
  for (const [k, a] of atingem) {
    const [A, B, C] = k.split('|').map(Number);
    const q: Trio = { A, B, C };
    const e = a.estoque as number;
    if (escolhido === null || e < escolhido.e - 1e-9 || (Math.abs(e - escolhido.e) <= 1e-9 && compararTrio(q, escolhido.q) < 0)) escolhido = { q, a, e };
  }
  return { quantil: escolhido!.q, inviavel: false, avaliacao: escolhido!.a, naoObservaveis, avaliacoes: memo.size, capitalIndeterminado: false };
}

// ── avaliação simulada na janela de calibração ──────────────────────────────────────────────────────────────────

export interface OpcoesCalibracao {
  reps?: number;
  /** Cache de grades em disco (null = sem disco; padrão $REPLAY_DADOS/cache). */
  cacheDir?: string | null;
  /**
   * Onde o alvo é medido. 'classe' (OFICIAL, padrão): células A/B/C da coorte inteira, com os suaves no F0. 'alt'
   * (INFORMATIVO, R27, NÃO OFICIAL): só a população ALTERADA é simulada e o fill sai das células A_alt/B_alt/C_alt.
   */
  celulasAlvo?: CelulasAlvo;
  /**
   * Modo PACOTE (spec 2026-11-09 §4.1): o mapa do F0′ nos SUAVES (`skus` = população − alterados da coorte). Ausente = modo
   * oficial, byte a byte. A linha de base (alvo, estoque do F0 e régua de 1 p.p.) continua o F0 de hoje nos 153 SKUs.
   */
  suaves?: { mapa: Map<string, ParamsDia>; skus: ReadonlySet<string> };
  /**
   * Só a ESTABILIDADE do pacote (informativa, §4.2): um corte da janela de calibração (fev–mar, mar–abr). Ausente = a janela
   * oficial. Os parâmetros continuam os do contexto da calibração (conhecimento até 30/04).
   */
  janela?: [Data, Data];
  /**
   * Só a ESTABILIDADE do pacote (leave-one-SKU-out, informativa, §4.2): este SKU sai da população MEDIDA nos dois braços —
   * vendas, estoque e peso no alvo (achado P2 do Codex: devolvê-lo ao F0 não é "sem ele"). Linha de base, alvo e capital
   * são os do recorte. A classe ABC dos demais é a da coorte (não reclassifica).
   */
  semSku?: string;
}

/** A população medida: a do modo, menos o SKU da estabilidade (leave-one-SKU-out). */
function populacaoMedida(c: { populacao: Set<string>; alterados: Set<string> }, modo: CelulasAlvo, semSku: string | undefined): Set<string> {
  const pop = populacaoDoModo(c, modo);
  if (semSku === undefined) return pop;
  if (!pop.has(semSku)) throw new Error(`SEM_SKU_FORA_DA_POPULACAO:${semSku}`);
  return new Set([...pop].filter((s) => s !== semSku));
}

/** R27: 'classe' = régua oficial; 'alt' = rodada informativa não oficial. */
export type CelulasAlvo = 'classe' | 'alt';
/** População simulada no modo: a coorte inteira (oficial) ou só os alterados (informativo, R27). */
export function populacaoDoModo(c: { populacao: Set<string>; alterados: Set<string> }, modo: CelulasAlvo): Set<string> {
  return modo === 'alt' ? c.alterados : c.populacao;
}

/** Simula `reps` replicações no contexto fixo da calibração e devolve o fill por classe e o estoque médio. */
export function avaliarNaCalibracao(
  dados: Dados,
  formula: Formula,
  params: Map<string, ParamsDia>,
  reps: number,
  celulas: CelulasAlvo = 'classe',
  janela: [Data, Data] = JANELA_CALIBRACAO,
): AvaliacaoTrio & { somas: SomasSemanais } {
  if (janela[0] < JANELAS.calibracaoIni || janela[1] > JANELAS.calibracaoFim || janela[0] > janela[1]) throw new Error(`JANELA_FORA_DA_CALIBRACAO:${janela.join('..')}`);
  let acc: SomasSemanais | null = null;
  for (let rep = 0; rep < reps; rep++) {
    const s = simular({ formula, params, rep, lt: 'empirico', falta: CENARIOS_FALTA.servico[0], inicial: 'reconstruido', janela, dados });
    acc = somarSomas(acc, s);
  }
  const m = mediaSomas(acc!, reps);
  const cel = (c: Classe): Celula => (celulas === 'alt' ? `${c}_alt` : c);
  return { fill: { A: fillDaCelula(m, cel('A')), B: fillDaCelula(m, cel('B')), C: fillDaCelula(m, cel('C')) }, estoque: estoqueComparavel(m), somas: m };
}

const QUANTIL_NEUTRO: ParamsFormula = { quantil: { A: 0.95, B: 0.95, C: 0.95 } };

/** Parâmetros no contexto da calibração (todos os ativos, dias até o fim da calibração; cache de grades opcional). */
function preComputarCtx(f: Formula, dados: Dados, p: ParamsFormula, o: OpcoesCalibracao): Map<string, ParamsDia> {
  return preComputarComOrigem(f, dados, p, { calibracao: true }, o.cacheDir === undefined ? {} : { cacheDir: o.cacheDir }).mapa;
}

interface BaseCalibracao {
  celulasAlvo: CelulasAlvo;
  f0Mapa: Map<string, ParamsDia>;
  /** Média das reps do F0 na calibração (diagnóstico). */
  somasF0: SomasSemanais;
  fillF0: Record<Classe, number | null>;
  /** null = estoque sem CMC na calibração do F0 (I2). */
  estoqueF0: number | null;
  alvo: Record<Classe, number | null>;
}
const memoBase = new WeakMap<Dados, Map<string, BaseCalibracao>>();

/** F0 na calibração: só para o alvo (spec §5.3) e para a régua de 1 p.p. de capital da escolha. */
export function baseDaCalibracao(dados: Dados, opcoes: OpcoesCalibracao = {}): BaseCalibracao {
  const reps = opcoes.reps ?? REPS_CALIBRACAO;
  let porReps = memoBase.get(dados);
  if (!porReps) memoBase.set(dados, (porReps = new Map()));
  const modo = opcoes.celulasAlvo ?? 'classe';
  const jan = opcoes.janela ?? JANELA_CALIBRACAO;
  // a chave oficial não muda; só o corte de estabilidade acrescenta a janela
  const chave =
    opcoes.janela || opcoes.semSku !== undefined ? `${reps}|${modo}|${jan.join('..')}|sem=${opcoes.semSku ?? '-'}` : `${reps}|${modo}`;
  const pronto = porReps.get(chave);
  if (pronto) return pronto;
  const c = coorte(dados);
  const f0Mapa = mapaMisto(preComputarCtx('F0', dados, QUANTIL_NEUTRO, opcoes), null, populacaoMedida(c, modo, opcoes.semSku), c.alterados);
  const a = avaliarNaCalibracao(dados, 'F0', f0Mapa, reps, modo, jan);
  const base: BaseCalibracao = {
    celulasAlvo: modo,
    f0Mapa,
    somasF0: a.somas,
    fillF0: a.fill,
    estoqueF0: a.estoque,
    alvo: { A: alvoDaClasse('A', a.fill.A), B: alvoDaClasse('B', a.fill.B), C: alvoDaClasse('C', a.fill.C) },
  };
  porReps.set(chave, base);
  return base;
}

export interface ResultadoCalibracao {
  formula: Formula;
  /** 'classe' = oficial; 'alt' = informativo (R27). */
  celulasAlvo: CelulasAlvo;
  params: ParamsFormula;
  inviavel: boolean;
  /** Estoque médio da coorte no trio escolhido (no inviável: o do trio final da busca, só informativo). null = sem CMC (I2). */
  estoqueMedio: number | null;
  /** Estoque médio do F0 na calibração (régua de 1 p.p. da escolha). null = sem CMC (I2). */
  estoqueF0: number | null;
  /** I2: a escolha do trio (ou do β/janela) não pôde usar capital — estoque sem CMC na calibração. */
  capitalIndeterminado: boolean;
  alvo: Record<Classe, number | null>;
  fillF0: Record<Classe, number | null>;
  fill: Record<Classe, number | null>;
  naoObservaveis: Classe[];
  /** Cada β (F2) ou janela (F3) tentado: o melhor viável vence. */
  tentativas: { params: ParamsFormula; inviavel: boolean; estoqueMedio: number | null; fill: Record<Classe, number | null>; avaliacoes: number }[];
}

/**
 * Calibra F1, F2 (por β) ou F3 (por janela) na janela de calibração: grade de quantis, descida por coordenada e validação
 * conjunta. Entre os β/janelas viáveis fica o de menor estoque (empate: o menor quantil, lexicográfico). Nenhum viável ⇒ inviável.
 */
export function calibrar(dados: Dados, f: Formula, opcoes: OpcoesCalibracao = {}): ResultadoCalibracao {
  if (f === 'F0') throw new Error('CALIBRAR_F0: o F0 não é calibrado (só dá o alvo)');
  const reps = opcoes.reps ?? REPS_CALIBRACAO;
  const base = baseDaCalibracao(dados, opcoes);
  const c = coorte(dados);
  const sv = opcoes.suaves;
  if (sv && base.celulasAlvo !== 'classe') throw new Error('PACOTE_SO_NA_CELULA_DA_CLASSE');
  const variantes: Omit<ParamsFormula, 'quantil'>[] =
    f === 'F2' ? TSB.betas.map((beta) => ({ beta })) : f === 'F3' ? JANELAS_F3.map((janelaDias) => ({ janelaDias })) : [{}];
  const tentativas: ResultadoCalibracao['tentativas'] = [];
  let escolhida: { params: ParamsFormula; busca: ResultadoBusca } | null = null;
  let fallback: { params: ParamsFormula; busca: ResultadoBusca } | null = null;
  let indeterminado = false;
  for (const v of variantes) {
    const avaliar = (q: Trio): AvaliacaoTrio => {
      const p: ParamsFormula = { ...v, quantil: q };
      const fn = preComputarCtx(f, dados, p, opcoes);
      const pop = populacaoMedida(c, base.celulasAlvo, opcoes.semSku);
      const mapa = sv ? mapaPacote(base.f0Mapa, sv.mapa, sv.skus, fn, pop, c.alterados) : mapaMisto(base.f0Mapa, fn, pop, c.alterados);
      return avaliarNaCalibracao(dados, f, mapa, reps, base.celulasAlvo, opcoes.janela ?? JANELA_CALIBRACAO);
    };
    const busca = buscarTrio(avaliar, base.alvo);
    const params: ParamsFormula = { ...v, quantil: busca.quantil };
    tentativas.push({ params, inviavel: busca.inviavel, estoqueMedio: busca.avaliacao.estoque, fill: busca.avaliacao.fill, avaliacoes: busca.avaliacoes });
    if (busca.capitalIndeterminado) indeterminado = true;
    // menor estoque; empate (≤ 1e-9) → menor quantil (lexicográfico), como dentro da busca. Estoque null (I2) nunca vence.
    const melhor = (atual: { busca: ResultadoBusca } | null): boolean => {
      const e = busca.avaliacao.estoque;
      if (atual === null) return true;
      const ea = atual.busca.avaliacao.estoque;
      if (e === null || ea === null) return false;
      return e < ea - 1e-9 || (Math.abs(e - ea) <= 1e-9 && compararTrio(busca.quantil, atual.busca.quantil) < 0);
    };
    if (!busca.inviavel && melhor(escolhida)) escolhida = { params, busca };
    if (melhor(fallback)) fallback = { params, busca };
  }
  const r = (escolhida ?? fallback)!;
  return {
    formula: f,
    celulasAlvo: base.celulasAlvo,
    params: r.params,
    inviavel: escolhida === null,
    estoqueMedio: indeterminado ? null : r.busca.avaliacao.estoque,
    estoqueF0: base.estoqueF0,
    capitalIndeterminado: indeterminado || base.estoqueF0 === null,
    alvo: base.alvo,
    fillF0: base.fillF0,
    fill: r.busca.avaliacao.fill,
    naoObservaveis: r.busca.naoObservaveis,
    tentativas,
  };
}

// ── escolha da candidata e veredito da calibração ────────────────────────────────────────────────────────────────

/**
 * Candidata = a viável de menor estoque; uma mais simples (F1 < F3 < F2) a ≤ 1 p.p. de capital (fração do estoque do F0
 * na calibração) dela fica com a vaga. Nenhuma viável ⇒ 'NENHUMA'. I2: alguma viável (ou o F0) com estoque não valorado
 * ⇒ 'INDETERMINADA' — a escolha exigiria comparar subtotais valorados, e nenhuma fórmula vence por subtotal.
 */
export function escolherCandidata(
  resultados: readonly Pick<ResultadoCalibracao, 'formula' | 'inviavel' | 'estoqueMedio' | 'estoqueF0'>[],
): Formula | 'NENHUMA' | 'INDETERMINADA' {
  const viaveis = resultados.filter((r) => !r.inviavel);
  if (viaveis.length === 0) return 'NENHUMA';
  if (viaveis.some((r) => r.estoqueMedio === null || r.estoqueF0 === null)) return 'INDETERMINADA';
  const est = (r: (typeof viaveis)[number]) => r.estoqueMedio as number;
  const melhor = viaveis.reduce((a, b) => (est(b) < est(a) - 1e-9 ? b : a));
  for (const f of ORDEM_SIMPLICIDADE) {
    const r = viaveis.find((x) => x.formula === f);
    if (!r) continue;
    const e0 = r.estoqueF0 as number;
    if (!(e0 > 0)) throw new Error('CALIBRACAO_ESTOQUE_F0_INVALIDO');
    if ((est(r) - est(melhor)) / e0 <= TOLERANCIA_SIMPLICIDADE_PP + 1e-12) return f;
  }
  return melhor.formula;
}

/** Veredito que a calibração já decide: todas inviáveis ⇒ NO-GO `INVIAVEL_NA_CALIBRACAO`; classe não observável ⇒ INCONCLUSIVO. */
export function vereditoDaCalibracao(
  resultados: readonly Pick<ResultadoCalibracao, 'formula' | 'inviavel' | 'estoqueMedio' | 'estoqueF0' | 'naoObservaveis'>[],
): { veredito: 'NO-GO' | 'INCONCLUSIVO'; motivos: string[] } | null {
  const cand = escolherCandidata(resultados);
  if (cand === 'NENHUMA') return { veredito: 'NO-GO', motivos: ['INVIAVEL_NA_CALIBRACAO'] };
  if (cand === 'INDETERMINADA') return { veredito: 'INCONCLUSIVO', motivos: ['CAPITAL_NAO_VALORADO_NA_CALIBRACAO'] };
  const r = resultados.find((x) => x.formula === cand)!;
  if (r.naoObservaveis.length > 0) return { veredito: 'INCONCLUSIVO', motivos: [`CLASSE_NAO_OBSERVAVEL_NA_CALIBRACAO:${r.naoObservaveis.join(',')}`] };
  return null;
}

// ── modo PACOTE (spec 2026-11-09 §4.2): F0′ nos suaves × X ∈ {F1, F2, F3} nos intermitentes ─────────────────────────────

/**
 * Parâmetros da população no pacote: `fn` nos `alterados` (os intermitentes ORIGINAIS), o F0′ (`suavesLinha`) nos `suaves`
 * e o F0 nos demais. Um SKU alterado nunca recebe o F0′ (a máscara de *_alt continua a dos alterados).
 */
export function mapaPacote(
  f0: Map<string, ParamsDia>,
  suavesLinha: Map<string, ParamsDia>,
  suaves: ReadonlySet<string>,
  fn: Map<string, ParamsDia>,
  populacao: ReadonlySet<string>,
  alterados: ReadonlySet<string>,
): Map<string, ParamsDia> {
  const out = new Map<string, ParamsDia>();
  for (const [k, p] of f0) {
    const sku = k.slice(0, k.indexOf('|'));
    if (!populacao.has(sku)) continue;
    const fonte = alterados.has(sku) ? fn : suaves.has(sku) ? suavesLinha : null;
    if (fonte === null) {
      out.set(k, p);
      continue;
    }
    const q = fonte.get(k);
    if (q === undefined) throw new Error(`MAPA_PACOTE_SEM_PARAMETRO:${k}`);
    out.set(k, q);
  }
  return out;
}

/** Perfil dos suaves no pacote: um perfil do F0′ (P0, Alt1, Alt2a, Alt2b) ou a F1 do simulador com quantil uniforme q (Alt3). */
export type PerfilSuaves = { tipo: 'F0'; perfil: PerfilF0 } | { tipo: 'F1'; q: number };
/** X do pacote (D4): as três fórmulas dos intermitentes. */
export const FORMULAS_PACOTE: readonly Formula[] = ['F1', 'F2', 'F3'];

/** §4.2, item 1: a lista finita de perfis, fixada antes da rodada. */
export function perfisDoPacote(): PerfilSuaves[] {
  return [
    { tipo: 'F0', perfil: PERFIL_P0 },
    { tipo: 'F0', perfil: { nome: 'Alt1' } },
    ...GRADE_Z_A.map((zA): PerfilSuaves => ({ tipo: 'F0', perfil: { nome: 'Alt2a', zA } })),
    ...GRADE_Z_A.map((zA): PerfilSuaves => ({ tipo: 'F0', perfil: { nome: 'Alt2b', zA } })),
    ...GRADE_QUANTIS.map((q): PerfilSuaves => ({ tipo: 'F1', q })),
  ];
}
export const chavePerfilSuaves = (p: PerfilSuaves): string => (p.tipo === 'F1' ? `Alt3:q${p.q}` : chavePerfil(p.perfil));
/** §4.2, item 4(b): P0 < Alt1 < Alt2 < Alt3. */
const rankPerfil = (p: PerfilSuaves): number => (p.tipo === 'F1' ? 3 : p.perfil.nome === 'P0' ? 0 : p.perfil.nome === 'Alt1' ? 1 : 2);
/** §4.2, item 4(c): o z(A) da Alt2 ou o q da Alt3 (0 nos demais). */
const nivelPerfil = (p: PerfilSuaves): number => (p.tipo === 'F1' ? p.q : p.perfil.nome === 'Alt2a' || p.perfil.nome === 'Alt2b' ? p.perfil.zA : 0);

/** Os suaves da coorte (D2: a correção vale só neles): população − alterados. */
export function suavesDaCoorte(c: { populacao: ReadonlySet<string>; alterados: ReadonlySet<string> }): Set<string> {
  return new Set([...c.populacao].filter((s) => !c.alterados.has(s)));
}

/** O mapa do perfil nos suaves da coorte, no contexto pedido (calibração ou avaliação; dias padrão do contexto). */
export function mapaDosSuaves(dados: Dados, perfil: PerfilSuaves, ctx: { calibracao: boolean }, cacheDir?: string | null): Map<string, ParamsDia> {
  const skus = [...suavesDaCoorte(coorte(dados))].sort();
  const o = cacheDir === undefined ? {} : { cacheDir };
  if (perfil.tipo === 'F1') {
    const q = perfil.q;
    return preComputarComOrigem('F1', dados, { quantil: { A: q, B: q, C: q } }, { calibracao: ctx.calibracao, skus }, o).mapa;
  }
  return preComputarComOrigem('F0', dados, QUANTIL_NEUTRO, { calibracao: ctx.calibracao, skus, perfilF0: perfil.perfil }, o).mapa;
}

/** §4.2, item 5: três estados, nunca dois. Dado ausente (capital sem preço) nunca vira inviável. */
export type EstadoTupla = 'VIAVEL' | 'INVIAVEL' | 'INDETERMINADO';
type ResumoEstado = Pick<ResultadoCalibracao, 'inviavel' | 'estoqueMedio' | 'estoqueF0' | 'capitalIndeterminado' | 'naoObservaveis'>;
/**
 * Por que a tupla é INDETERMINADA (null = não é). Capital sem preço e classe sem demanda na calibração (alvo inobservável:
 * nem o atingimento nem a inviabilidade estão provados — achado P2 do Codex) são motivos DISTINTOS, nunca rotulados um pelo outro.
 */
export function motivoIndeterminacao(r: ResumoEstado): string | null {
  if (r.capitalIndeterminado) return 'CAPITAL_NAO_VALORADO_NA_CALIBRACAO';
  if (r.naoObservaveis.length > 0) return `CLASSE_NAO_OBSERVAVEL_NA_CALIBRACAO:${r.naoObservaveis.join(',')}`;
  if (r.inviavel) return null;
  return r.estoqueMedio === null || r.estoqueF0 === null ? 'CAPITAL_NAO_VALORADO_NA_CALIBRACAO' : null;
}
export function estadoDaTupla(r: ResumoEstado): EstadoTupla {
  if (motivoIndeterminacao(r) !== null) return 'INDETERMINADO';
  return r.inviavel ? 'INVIAVEL' : 'VIAVEL';
}

/** Uma tupla congelável (P, X, β ou janela, quantis A/B/C) com o resultado da calibração existente, sem mudança. */
export interface TuplaPacote {
  perfil: PerfilSuaves;
  resultado: ResultadoCalibracao;
}
export const serializarTupla = (t: TuplaPacote): string =>
  `${chavePerfilSuaves(t.perfil)}|${t.resultado.formula}|beta=${t.resultado.params.beta ?? '-'}|janela=${t.resultado.params.janelaDias ?? '-'}|q=${t.resultado.params.quantil.A},${t.resultado.params.quantil.B},${t.resultado.params.quantil.C}`;

/** §4.2, item 2: para cada perfil P, a calibração existente para X ∈ {F1, F2, F3}. */
export function calibrarPacote(
  dados: Dados,
  opcoes: OpcoesCalibracao & {
    perfis?: readonly PerfilSuaves[];
    formulas?: readonly Formula[];
    log?: (m: string) => void;
  } = {},
): TuplaPacote[] {
  if ((opcoes.celulasAlvo ?? 'classe') !== 'classe') throw new Error('PACOTE_SO_NA_CELULA_DA_CLASSE');
  const skus = suavesDaCoorte(coorte(dados));
  // leave-one-SKU-out: o suave sai da população medida (OpcoesCalibracao.semSku), não só do conjunto dos suaves
  if (opcoes.semSku !== undefined && !skus.delete(opcoes.semSku)) throw new Error(`SEM_SUAVE_FORA_DOS_SUAVES:${opcoes.semSku}`);
  const out: TuplaPacote[] = [];
  for (const perfil of opcoes.perfis ?? perfisDoPacote()) {
    const mapa = mapaDosSuaves(dados, perfil, { calibracao: true }, opcoes.cacheDir);
    for (const f of opcoes.formulas ?? FORMULAS_PACOTE) {
      const resultado = calibrar(dados, f, { ...opcoes, suaves: { mapa, skus } });
      out.push({ perfil, resultado });
      opcoes.log?.(`pacote ${chavePerfilSuaves(perfil)} × ${f}: ${estadoDaTupla(resultado)} ${JSON.stringify(resultado.params)} fill ${JSON.stringify(resultado.fill)}`);
    }
  }
  return out;
}

export type EscolhaPacote = { tipo: 'TUPLA'; tupla: TuplaPacote } | { tipo: 'NENHUMA' } | { tipo: 'INDETERMINADA'; tuplas: { tupla: string; motivo: string }[] };

/**
 * §4.2, itens 3–5. Candidata = a tupla VIÁVEL de menor estoque médio; desempate, nesta ordem: (a) a regra de simplicidade
 * da mãe (a fórmula mais simples, F1 < F3 < F2, com alguma tupla a ≤ 1 p.p. de capital do F0 da de menor estoque fica com
 * a vaga; dentro dela, a de menor estoque); entre estoques empatados (≤ 1e-9): (b) perfil mais simples, (c) menor z(A) ou
 * q, (d) a tupla serializada em ordem lexicográfica. Qualquer tupla INDETERMINADA ⇒ seleção INDETERMINADA: o estoque dela
 * é desconhecido e pode ser menor que o da escolhida (ou ela pode ser a única viável); nunca se escolhe por exclusão.
 */
export function escolherTupla(tuplas: readonly TuplaPacote[]): EscolhaPacote {
  const indeterminadas = tuplas.filter((t) => estadoDaTupla(t.resultado) === 'INDETERMINADO');
  if (indeterminadas.length > 0)
    return { tipo: 'INDETERMINADA', tuplas: indeterminadas.map((t) => ({ tupla: serializarTupla(t), motivo: motivoIndeterminacao(t.resultado)! })) };
  const viaveis = tuplas.filter((t) => estadoDaTupla(t.resultado) === 'VIAVEL');
  if (viaveis.length === 0) return { tipo: 'NENHUMA' };
  const est = (t: TuplaPacote) => t.resultado.estoqueMedio as number;
  const e0 = viaveis[0].resultado.estoqueF0 as number;
  if (!(e0 > 0)) throw new Error('CALIBRACAO_ESTOQUE_F0_INVALIDO');
  if (viaveis.some((t) => Math.abs((t.resultado.estoqueF0 as number) - e0) > 1e-9 * Math.max(1, e0))) throw new Error('PACOTE_LINHA_DE_BASE_DIVERGENTE');
  const minimo = viaveis.reduce((m, t) => Math.min(m, est(t)), Infinity);
  let pool = viaveis;
  for (const f of ORDEM_SIMPLICIDADE) {
    const cands = viaveis.filter((t) => t.resultado.formula === f && (est(t) - minimo) / e0 <= TOLERANCIA_SIMPLICIDADE_PP + 1e-12);
    if (cands.length > 0) {
      pool = cands;
      break;
    }
  }
  const ordem = (a: TuplaPacote, b: TuplaPacote): number => {
    if (Math.abs(est(a) - est(b)) > 1e-9) return est(a) - est(b);
    const sa = serializarTupla(a);
    const sb = serializarTupla(b);
    return rankPerfil(a.perfil) - rankPerfil(b.perfil) || nivelPerfil(a.perfil) - nivelPerfil(b.perfil) || (sa < sb ? -1 : sa > sb ? 1 : 0);
  };
  return { tipo: 'TUPLA', tupla: [...pool].sort(ordem)[0] };
}

/** O veredito que a calibração do pacote já decide (mesma semântica de `vereditoDaCalibracao`). */
export function vereditoDaCalibracaoPacote(escolha: EscolhaPacote): { veredito: 'NO-GO' | 'INCONCLUSIVO'; motivos: string[] } | null {
  if (escolha.tipo === 'NENHUMA') return { veredito: 'NO-GO', motivos: ['INVIAVEL_NA_CALIBRACAO'] };
  if (escolha.tipo === 'INDETERMINADA') {
    const porMotivo = new Map<string, string[]>();
    for (const t of escolha.tuplas) porMotivo.set(t.motivo, [...(porMotivo.get(t.motivo) ?? []), t.tupla]);
    return { veredito: 'INCONCLUSIVO', motivos: [...porMotivo].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([m, ts]) => `${m}: ${ts.join(', ')}`) };
  }
  // a tupla escolhida é VIÁVEL ⇒ observável por construção (estadoDaTupla); a guarda fica como defesa
  const r = escolha.tupla.resultado;
  if (r.naoObservaveis.length > 0) throw new Error(`PACOTE_TUPLA_VIAVEL_INOBSERVAVEL:${r.naoObservaveis.join(',')}`);
  return null;
}
