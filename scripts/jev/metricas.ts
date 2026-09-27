/**
 * metricas.ts — métricas PURAS do backtest do Jev (PR0). Sem I/O, sem rede, sem relógio.
 *
 * Régua (docs/historico/jev-backtest-ptbr.md): a unidade é 1 ITEM decidido; o erro que importa é
 * "respondeu acima do limiar e errou" (automação errada), não "absteve". Por isso:
 *   - cobertura = respondidas / TOTAL (falha operacional fica no denominador, nunca some);
 *   - acerto    = acertos / respondidas, e é NULL sem respondidas (ausente ≠ zero);
 *   - o portão usa o LIMITE SUPERIOR do erro (Clopper-Pearson 95%), não o erro observado —
 *     com N pequeno o observado é otimista, e "0 erros em 40" não sustenta alvo de 2%.
 *
 * `prob` é SEMPRE `probabilities[choice]` do Jev. O campo `confidence` da API NÃO é
 * probabilidade de acerto (a doc oficial o define como estatística do formato da distribuição,
 * ≈ (N·p_max−1)/(N−1)); ele entra só como ESCORE de seleção alternativo, nunca no ECE.
 */

export interface Predicao {
  /** Opção escolhida (inclui 'nenhum'). null = sem resposta (falha operacional ou regra que absteve). */
  escolha: string | null;
  /** Probabilidade que o modelo deu à PRÓPRIA escolha. null = sem probabilidade. */
  prob: number | null;
  /** escolha ∈ gabarito do item. */
  correta: boolean;
}

export interface ResultadoCobertura {
  total: number;
  respondidas: number;
  acertos: number;
  erros: number;
  /** Itens sem resposta por falha operacional (não por limiar). Contam no total. */
  falhas: number;
  /** respondidas / total; null sem itens. */
  cobertura: number | null;
  /** acertos / respondidas; null sem respondidas. */
  acerto: number | null;
  /** Limite superior unilateral 95% da taxa de erro nas respondidas; null sem respondidas. */
  limiteSuperiorErro: number | null;
}

function resumir(total: number, respondidas: number, acertos: number, falhas: number): ResultadoCobertura {
  const erros = respondidas - acertos;
  return {
    total,
    respondidas,
    acertos,
    erros,
    falhas,
    cobertura: total > 0 ? respondidas / total : null,
    acerto: respondidas > 0 ? acertos / respondidas : null,
    limiteSuperiorErro: limiteSuperiorErro(erros, respondidas),
  };
}

/** Modelo com probabilidade: responde quando `prob ≥ limiar` (inclusivo); abaixo, abstém (null). */
export function avaliarLimiar(itens: readonly Predicao[], limiar: number): ResultadoCobertura {
  let respondidas = 0;
  let acertos = 0;
  let falhas = 0;
  for (const p of itens) {
    if (p.escolha === null || p.prob === null) {
      falhas++;
      continue;
    }
    if (p.prob >= limiar) {
      respondidas++;
      if (p.correta) acertos++;
    }
  }
  return resumir(itens.length, respondidas, acertos, falhas);
}

/** Regra determinística (baseline): responde quando escolhe; `escolha = null` é abstenção. */
export function avaliarRegra(itens: readonly Pick<Predicao, 'escolha' | 'correta'>[]): ResultadoCobertura {
  let respondidas = 0;
  let acertos = 0;
  for (const p of itens) {
    if (p.escolha === null) continue;
    respondidas++;
    if (p.correta) acertos++;
  }
  return resumir(itens.length, respondidas, acertos, 0);
}

export interface FaixaConfiabilidade {
  de: number;
  ate: number;
  n: number;
  /** Média de `prob` na faixa; null se vazia. */
  confMedia: number | null;
  /** Fração correta na faixa; null se vazia. */
  acerto: number | null;
}

export interface ResultadoEce {
  /** Σ (n_faixa/N)·|acerto − conf|; null sem nenhum item com probabilidade. */
  ece: number | null;
  /** Itens COM probabilidade (o denominador do ECE). */
  n: number;
  /** Itens excluídos por não terem probabilidade (falha ou regra). */
  semProb: number;
  faixas: FaixaConfiabilidade[];
}

/** ECE em `nFaixas` faixas iguais em [0,1]; a última faixa é fechada (prob = 1 entra nela). */
export function calcularEce(itens: readonly Predicao[], nFaixas = 10): ResultadoEce {
  const acc = Array.from({ length: nFaixas }, () => ({ n: 0, somaConf: 0, acertos: 0 }));
  let semProb = 0;
  for (const p of itens) {
    if (p.escolha === null || p.prob === null) {
      semProb++;
      continue;
    }
    const idx = Math.min(nFaixas - 1, Math.max(0, Math.floor(p.prob * nFaixas)));
    acc[idx].n++;
    acc[idx].somaConf += p.prob;
    if (p.correta) acc[idx].acertos++;
  }
  const n = acc.reduce((s, f) => s + f.n, 0);
  const faixas: FaixaConfiabilidade[] = acc.map((f, i) => ({
    de: i / nFaixas,
    ate: (i + 1) / nFaixas,
    n: f.n,
    confMedia: f.n > 0 ? f.somaConf / f.n : null,
    acerto: f.n > 0 ? f.acertos / f.n : null,
  }));
  if (n === 0) return { ece: null, n, semProb, faixas };
  let ece = 0;
  for (const f of faixas) {
    if (f.n === 0 || f.confMedia === null || f.acerto === null) continue;
    ece += (f.n / n) * Math.abs(f.acerto - f.confMedia);
  }
  return { ece, n, semProb, faixas };
}

/** P(X ≤ k) para X ~ Binomial(n, p), somado em espaço log (sem underflow para n grande). */
function binomialAcumulada(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  const logP = Math.log(p);
  const log1mP = Math.log1p(-p);
  let logTermo = n * log1mP; // i = 0
  let soma = Math.exp(logTermo);
  for (let i = 0; i < k; i++) {
    logTermo += Math.log(n - i) - Math.log(i + 1) + logP - log1mP;
    soma += Math.exp(logTermo);
  }
  return Math.min(1, soma);
}

/**
 * Limite superior unilateral de Clopper-Pearson para a taxa de erro (`erros` em `n`).
 * 0 erros tem forma fechada (1 − α^(1/n)); o resto é bissecção em P(X ≤ erros) = α.
 */
export function limiteSuperiorErro(erros: number, n: number, confianca = 0.95): number | null {
  if (n <= 0) return null;
  if (erros >= n) return 1;
  const alfa = 1 - confianca;
  if (erros <= 0) return 1 - Math.pow(alfa, 1 / n);
  let lo = erros / n;
  let hi = 1;
  for (let it = 0; it < 200; it++) {
    const meio = (lo + hi) / 2;
    if (binomialAcumulada(erros, n, meio) > alfa) lo = meio;
    else hi = meio;
  }
  return (lo + hi) / 2;
}

/**
 * "O limiar sai da NOSSA curva": o MENOR limiar da grade cujo limite superior do erro nas
 * respondidas cabe no alvo. Nenhum cabe ⇒ null = INCONCLUSIVO (N insuficiente ou modelo ruim);
 * nunca devolve o maior limiar da grade como se fosse resposta.
 */
export function limiarDaCurva(itens: readonly Predicao[], grade: readonly number[], erroAlvo: number): number | null {
  for (const t of [...grade].sort((x, y) => x - y)) {
    const r = avaliarLimiar(itens, t);
    if (r.respondidas > 0 && r.limiteSuperiorErro !== null && r.limiteSuperiorErro <= erroAlvo) return t;
  }
  return null;
}

export interface RespostaOrdem {
  escolha: string | null;
  prob: number | null;
}

export interface ParOrdem {
  id: string;
  a: RespostaOrdem;
  b: RespostaOrdem;
}

export interface SensibilidadeLimiar {
  limiar: number;
  /** Fração dos pares válidos cuja DECISÃO (escolha acima do limiar, ou abstenção) muda. */
  taxaDecisaoMuda: number | null;
  /** Pares em que as DUAS ordens respondem acima do limiar com opções diferentes — o pior caso. */
  trocasConfiantes: number;
  idsQueMudam: string[];
}

export interface ResultadoSensibilidade {
  paresValidos: number;
  /** Pares com falha em alguma das ordens (fora das taxas, mas contados). */
  paresInvalidos: number;
  taxaTrocaEscolha: number | null;
  porLimiar: SensibilidadeLimiar[];
}

/** Compara a MESMA pergunta respondida com as opções em ordens diferentes (ou repetida). */
export function sensibilidadeOrdem(pares: readonly ParOrdem[], limiares: readonly number[]): ResultadoSensibilidade {
  const validos = pares.filter(
    (p) => p.a.escolha !== null && p.a.prob !== null && p.b.escolha !== null && p.b.prob !== null,
  );
  const n = validos.length;
  const trocas = validos.filter((p) => p.a.escolha !== p.b.escolha).length;
  const decisao = (r: RespostaOrdem, t: number) => (r.prob !== null && r.prob >= t ? r.escolha : null);
  const porLimiar = limiares.map((limiar) => {
    const idsQueMudam: string[] = [];
    let trocasConfiantes = 0;
    for (const p of validos) {
      const da = decisao(p.a, limiar);
      const db = decisao(p.b, limiar);
      if (da !== db) {
        idsQueMudam.push(p.id);
        if (da !== null && db !== null) trocasConfiantes++;
      }
    }
    return { limiar, taxaDecisaoMuda: n > 0 ? idsQueMudam.length / n : null, trocasConfiantes, idsQueMudam };
  });
  return {
    paresValidos: n,
    paresInvalidos: pares.length - n,
    taxaTrocaEscolha: n > 0 ? trocas / n : null,
    porLimiar,
  };
}

/** Média das distribuições das duas ordens e argmax sobre a média (empate: a 1ª opção de `a`). */
export function combinarOrdens(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): { escolha: string; prob: number; probabilidades: Record<string, number> } {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length === 0 || ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
    throw new Error(`opções divergentes entre as ordens: [${ka.join(', ')}] × [${kb.join(', ')}]`);
  }
  const probabilidades: Record<string, number> = {};
  let escolha = '';
  let prob = -1;
  for (const k of Object.keys(a)) {
    const m = (a[k] + b[k]) / 2;
    probabilidades[k] = m;
    if (m > prob) {
      prob = m;
      escolha = k;
    }
  }
  return { escolha, prob, probabilidades };
}

/** Percentil por nearest-rank: o valor de posição ⌈p/100 · n⌉ na amostra ordenada. */
export function percentil(valores: readonly number[], p: number): number | null {
  if (valores.length === 0) return null;
  const ordenados = [...valores].sort((x, y) => x - y);
  const rank = Math.ceil((p / 100) * ordenados.length);
  return ordenados[Math.min(ordenados.length, Math.max(1, rank)) - 1];
}

/** Preço de tabela do jev-1.13 (docs.typesafe.ai/models, 2026-09-27): só ENTRADA é cobrada. */
export const USD_POR_MTOK_ENTRADA = 0.042;

export function custoUsd(tokensEntrada: number, usdPorMTok = USD_POR_MTOK_ENTRADA): number {
  return (tokensEntrada * usdPorMTok) / 1_000_000;
}
